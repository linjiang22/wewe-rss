import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import { defaultCount, statusMap } from '@server/constants';
import { FeishuLoginService } from '@server/trpc/feishu-login.service';
import { PrismaService } from '@server/prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { TRPCError, initTRPC } from '@trpc/server';
import Axios, { AxiosInstance } from 'axios';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 读书账号每日小黑屋
 */
const blockedAccountsMap = new Map<string, string[]>();

type LoginResult = {
  message: string;
  vid?: number;
  token?: string;
  username?: string;
};

@Injectable()
export class TrpcService {
  trpc = initTRPC.create();
  publicProcedure = this.trpc.procedure;
  protectedProcedure = this.trpc.procedure.use(({ ctx, next }) => {
    const errorMsg = (ctx as any).errorMsg;
    if (errorMsg) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: errorMsg });
    }
    return next({ ctx });
  });
  router = this.trpc.router;
  mergeRouters = this.trpc.mergeRouters;
  request: AxiosInstance;
  updateDelayTime = 60;
  private readonly feishuLoginTasks = new Set<string>();
  private readonly feishuLoginCardSentAt = new Map<string, number>();
  private readonly feishuLoginCardSendCounts = new Map<string, number>();

  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly feishuLoginService: FeishuLoginService,
  ) {
    const { url } =
      this.configService.get<ConfigurationType['platform']>('platform')!;
    this.updateDelayTime =
      this.configService.get<ConfigurationType['feed']>(
        'feed',
      )!.updateDelayTime;

    this.request = Axios.create({ baseURL: url, timeout: 15 * 1e3 });

    this.request.interceptors.response.use(
      (response) => {
        return response;
      },
      async (error) => {
        this.logger.log('error: ', error);
        const errMsg = error.response?.data?.message || '';

        const id = (error.config.headers as any).xid;
        if (errMsg.includes('WeReadError401')) {
          // 账号失效
          await this.prismaService.account.update({
            where: { id },
            data: { status: statusMap.INVALID },
          });
          this.logger.error(`账号（${id}）登录失效，已禁用`);
          this.triggerFeishuLoginCard(id);
        } else if (errMsg.includes('WeReadError429')) {
          //TODO 处理请求频繁
          this.logger.error(`账号（${id}）请求频繁，打入小黑屋`);
        }

        const today = this.getTodayDate();

        const blockedAccounts = blockedAccountsMap.get(today);

        if (Array.isArray(blockedAccounts)) {
          if (id) {
            blockedAccounts.push(id);
          }
          blockedAccountsMap.set(today, blockedAccounts);
        } else if (errMsg.includes('WeReadError400')) {
          this.logger.error(`账号（${id}）处理请求参数出错`);
          this.logger.error('WeReadError400: ', errMsg);
          // 10s 后重试
          await new Promise((resolve) => setTimeout(resolve, 10 * 1e3));
        } else {
          this.logger.error("Can't handle this error: ", errMsg);
        }

        return Promise.reject(error);
      },
    );
  }

  removeBlockedAccount = (vid: string) => {
    const today = this.getTodayDate();

    const blockedAccounts = blockedAccountsMap.get(today);
    if (Array.isArray(blockedAccounts)) {
      const newBlockedAccounts = blockedAccounts.filter((id) => id !== vid);
      blockedAccountsMap.set(today, newBlockedAccounts);
    }

    this.resetFeishuLoginCardSendCount(vid);
  };

  private triggerFeishuLoginCard(accountId?: string) {
    if (!accountId || !this.feishuLoginService.isEnabled()) {
      return;
    }

    const { loginCardCooldownSeconds, loginCardMaxSendsPerDay } =
      this.configService.get<ConfigurationType['feed']>('feed')!;
    const sentCount = this.getFeishuLoginCardSendCount(accountId);
    if (sentCount >= loginCardMaxSendsPerDay) {
      this.logger.log(
        `Feishu login card task for account ${accountId} skipped by daily limit (${sentCount}/${loginCardMaxSendsPerDay})`,
      );
      return;
    }

    const lastSentAt = this.feishuLoginCardSentAt.get(accountId) || 0;
    if (Date.now() - lastSentAt < loginCardCooldownSeconds * 1e3) {
      this.logger.log(
        `Feishu login card task for account ${accountId} skipped by cooldown`,
      );
      return;
    }

    if (this.feishuLoginTasks.has(accountId)) {
      this.logger.log(`Feishu login card task for account ${accountId} exists`);
      return;
    }

    this.feishuLoginTasks.add(accountId);
    void this.sendFeishuLoginCardAndPoll(accountId).finally(() => {
      this.feishuLoginTasks.delete(accountId);
    });
  }

  private async sendFeishuLoginCardAndPoll(accountId: string) {
    try {
      const login = await this.createLoginUrl();
      await this.feishuLoginService.sendLoginCard({
        accountId,
        uuid: login.uuid,
        scanUrl: login.scanUrl,
      });
      this.markFeishuLoginCardSent(accountId);

      const loginResult = await this.pollLoginResult(login.uuid, accountId);
      if (!loginResult.vid || !loginResult.token) {
        this.logger.warn(
          `Feishu login card task for account ${accountId} ended: ${
            loginResult.message || 'no login result'
          }`,
        );
        return;
      }

      const id = `${loginResult.vid}`;
      const name = loginResult.username || id;
      await this.prismaService.account.upsert({
        where: { id },
        update: {
          name,
          token: loginResult.token,
          status: statusMap.ENABLE,
        },
        create: {
          id,
          name,
          token: loginResult.token,
          status: statusMap.ENABLE,
        },
      });
      this.removeBlockedAccount(accountId);
      this.removeBlockedAccount(id);
      this.triggerRefreshAllMpArticlesAndUpdateFeed(
        `account ${id} login success from Feishu card`,
      );
    } catch (err) {
      this.logger.error(
        `Feishu login card task for account ${accountId} failed`,
        err,
      );
    }
  }

  private async pollLoginResult(uuid: string, accountId: string) {
    const { loginCardPollTimeoutSeconds } =
      this.configService.get<ConfigurationType['feed']>('feed')!;
    const pollIntervalSeconds = 5;
    const maxAttempts = Math.max(
      1,
      Math.ceil(loginCardPollTimeoutSeconds / pollIntervalSeconds),
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const loginResult = await this.getLoginResult(uuid, 15 * 1e3).catch(
        (err) => {
          this.logger.warn(
            `Feishu login card task for account ${accountId} poll login result failed (${attempt}/${maxAttempts}): ${
              err?.message || err
            }`,
          );
          return { message: 'waiting' } as LoginResult;
        },
      );
      if (loginResult.vid && loginResult.token) {
        return loginResult;
      }

      this.logger.log(
        `Feishu login card task for account ${accountId} waiting login result (${attempt}/${maxAttempts}): ${
          loginResult.message || 'waiting'
        }`,
      );

      await new Promise((resolve) =>
        setTimeout(resolve, pollIntervalSeconds * 1e3),
      );
    }

    return {
      message: 'login timeout',
    };
  }

  private getTodayDate() {
    return dayjs.tz(new Date(), 'Asia/Shanghai').format('YYYY-MM-DD');
  }

  private getFeishuLoginCardSendCountKey(accountId: string) {
    return `${this.getTodayDate()}:${accountId}`;
  }

  private getFeishuLoginCardSendCount(accountId: string) {
    return (
      this.feishuLoginCardSendCounts.get(
        this.getFeishuLoginCardSendCountKey(accountId),
      ) || 0
    );
  }

  private markFeishuLoginCardSent(accountId: string) {
    this.feishuLoginCardSentAt.set(accountId, Date.now());
    const countKey = this.getFeishuLoginCardSendCountKey(accountId);
    this.feishuLoginCardSendCounts.set(
      countKey,
      (this.feishuLoginCardSendCounts.get(countKey) || 0) + 1,
    );
  }

  private resetFeishuLoginCardSendCount(accountId: string) {
    this.feishuLoginCardSendCounts.delete(
      this.getFeishuLoginCardSendCountKey(accountId),
    );
    this.feishuLoginCardSentAt.delete(accountId);
  }

  getBlockedAccountIds() {
    const today = this.getTodayDate();
    const disabledAccounts = blockedAccountsMap.get(today) || [];
    this.logger.debug('disabledAccounts: ', disabledAccounts);
    return disabledAccounts.filter(Boolean);
  }

  @Cron(process.env.LOGIN_CHECK_CRON || '0 */6 * * *', {
    name: 'checkAccountLoginStatus',
    timeZone: 'Asia/Shanghai',
  })
  async handleCheckAccountLoginStatusCron() {
    const { loginCheckEnabled } =
      this.configService.get<ConfigurationType['feed']>('feed')!;
    if (!loginCheckEnabled) {
      return;
    }

    if (!this.shouldRunLoginCheckNow()) {
      return;
    }

    await this.checkAccountLoginStatus();
  }

  private shouldRunLoginCheckNow() {
    const { loginCheckStartTime, loginCheckIntervalMinutes } =
      this.configService.get<ConfigurationType['feed']>('feed')!;

    if (!loginCheckStartTime || loginCheckIntervalMinutes <= 0) {
      return true;
    }

    const match = loginCheckStartTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      this.logger.warn(
        `skip account login check: invalid LOGIN_CHECK_START_TIME ${loginCheckStartTime}`,
      );
      return false;
    }

    const [, hourValue, minuteValue] = match;
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    if (hour > 23 || minute > 59) {
      this.logger.warn(
        `skip account login check: invalid LOGIN_CHECK_START_TIME ${loginCheckStartTime}`,
      );
      return false;
    }

    const now = dayjs.tz(new Date(), 'Asia/Shanghai');
    const start = now
      .startOf('day')
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);

    if (now.isBefore(start)) {
      return false;
    }

    return now.diff(start, 'minute') % loginCheckIntervalMinutes === 0;
  }

  async checkAccountLoginStatus() {
    const { loginCheckMpId } =
      this.configService.get<ConfigurationType['feed']>('feed')!;

    const invalidAccounts = await this.prismaService.account.findMany({
      where: { status: statusMap.INVALID },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const account of invalidAccounts) {
      this.logger.warn(
        `账号（${account.id}）已是失效状态，发送微信登录卡片`,
      );
      this.triggerFeishuLoginCard(account.id);
    }

    const probeFeedId =
      loginCheckMpId ||
      (
        await this.prismaService.feed.findFirst({
          where: { status: statusMap.ENABLE },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        })
      )?.id;

    if (!probeFeedId) {
      this.logger.warn('skip account login check: no enabled feed');
      return;
    }

    const accounts = await this.prismaService.account.findMany({
      where: { status: statusMap.ENABLE },
      orderBy: { createdAt: 'asc' },
    });

    if (accounts.length === 0) {
      this.logger.warn('skip account login check: no enabled account');
      return;
    }

    this.logger.log(
      `check account login status, accounts: ${accounts.length}, probeFeedId: ${probeFeedId}`,
    );

    for (const account of accounts) {
      try {
        await this.request.get(`/api/v2/platform/mps/${probeFeedId}/articles`, {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`,
          },
          params: { page: 1 },
        });
        this.logger.log(`账号（${account.id}）登录状态正常`);
      } catch (err) {
        this.logger.error(`check account(${account.id}) login status error`, err);
      }
    }
  }

  private async getAvailableAccount() {
    const disabledAccounts = this.getBlockedAccountIds();
    const account = await this.prismaService.account.findMany({
      where: {
        status: statusMap.ENABLE,
        NOT: {
          id: { in: disabledAccounts },
        },
      },
      take: 10,
    });

    if (!account || account.length === 0) {
      throw new Error('暂无可用读书账号!');
    }

    return account[Math.floor(Math.random() * account.length)];
  }

  async getMpArticles(mpId: string, page = 1, retryCount = 3) {
    const account = await this.getAvailableAccount();

    try {
      const res = await this.request
        .get<
          {
            id: string;
            title: string;
            picUrl: string;
            publishTime: number;
          }[]
        >(`/api/v2/platform/mps/${mpId}/articles`, {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`,
          },
          params: {
            page,
          },
        })
        .then((res) => res.data)
        .then((res) => {
          this.logger.log(
            `getMpArticles(${mpId}) page: ${page} articles: ${res.length}`,
          );
          return res;
        });
      return res;
    } catch (err) {
      this.logger.error(`retry(${4 - retryCount}) getMpArticles  error: `, err);
      if (retryCount > 0) {
        return this.getMpArticles(mpId, page, retryCount - 1);
      } else {
        throw err;
      }
    }
  }

  async refreshMpArticlesAndUpdateFeed(mpId: string, page = 1) {
    const articles = await this.getMpArticles(mpId, page);

    if (articles.length > 0) {
      let results;
      const { type } =
        this.configService.get<ConfigurationType['database']>('database')!;
      if (type === 'sqlite') {
        // sqlite3 不支持 createMany
        const inserts = articles.map(({ id, picUrl, publishTime, title }) =>
          this.prismaService.article.upsert({
            create: { id, mpId, picUrl, publishTime, title },
            update: {
              publishTime,
              title,
            },
            where: { id },
          }),
        );
        results = await this.prismaService.$transaction(inserts);
      } else {
        results = await (this.prismaService.article as any).createMany({
          data: articles.map(({ id, picUrl, publishTime, title }) => ({
            id,
            mpId,
            picUrl,
            publishTime,
            title,
          })),
          skipDuplicates: true,
        });
      }

      this.logger.debug(
        `refreshMpArticlesAndUpdateFeed create results: ${JSON.stringify(results)}`,
      );
    }

    // 如果文章数量小于 defaultCount，则认为没有更多历史文章
    const hasHistory = articles.length < defaultCount ? 0 : 1;

    await this.prismaService.feed.update({
      where: { id: mpId },
      data: {
        syncTime: Math.floor(Date.now() / 1e3),
        hasHistory,
      },
    });

    return { hasHistory };
  }

  inProgressHistoryMp = {
    id: '',
    page: 1,
  };

  async getHistoryMpArticles(mpId: string) {
    if (this.inProgressHistoryMp.id === mpId) {
      this.logger.log(`getHistoryMpArticles(${mpId}) is running`);
      return;
    }

    this.inProgressHistoryMp = {
      id: mpId,
      page: 1,
    };

    if (!this.inProgressHistoryMp.id) {
      return;
    }

    try {
      const feed = await this.prismaService.feed.findFirstOrThrow({
        where: {
          id: mpId,
        },
      });

      // 如果完整同步过历史文章，则直接返回
      if (feed.hasHistory === 0) {
        this.logger.log(`getHistoryMpArticles(${mpId}) has no history`);
        return;
      }

      const total = await this.prismaService.article.count({
        where: {
          mpId,
        },
      });
      this.inProgressHistoryMp.page = Math.ceil(total / defaultCount);

      // 最多尝试一千次
      let i = 1e3;
      while (i-- > 0) {
        if (this.inProgressHistoryMp.id !== mpId) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) is not running, break`,
          );
          break;
        }
        const { hasHistory } = await this.refreshMpArticlesAndUpdateFeed(
          mpId,
          this.inProgressHistoryMp.page,
        );
        if (hasHistory < 1) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) has no history, break`,
          );
          break;
        }
        this.inProgressHistoryMp.page++;

        await new Promise((resolve) =>
          setTimeout(resolve, this.updateDelayTime * 1e3),
        );
      }
    } finally {
      this.inProgressHistoryMp = {
        id: '',
        page: 1,
      };
    }
  }

  isRefreshAllMpArticlesRunning = false;

  triggerRefreshAllMpArticlesAndUpdateFeed(reason: string) {
    this.logger.log(
      `trigger refreshAllMpArticlesAndUpdateFeed, reason: ${reason}`,
    );
    void this.refreshAllMpArticlesAndUpdateFeed().catch((err) => {
      this.logger.error(
        `refreshAllMpArticlesAndUpdateFeed failed, reason: ${reason}`,
        err,
      );
    });
  }

  async refreshAllMpArticlesAndUpdateFeed() {
    if (this.isRefreshAllMpArticlesRunning) {
      this.logger.log('refreshAllMpArticlesAndUpdateFeed is running');
      return;
    }
    const mps = await this.prismaService.feed.findMany();
    this.isRefreshAllMpArticlesRunning = true;
    try {
      for (const { id } of mps) {
        await this.refreshMpArticlesAndUpdateFeed(id);

        await new Promise((resolve) =>
          setTimeout(resolve, this.updateDelayTime * 1e3),
        );
      }
    } finally {
      this.isRefreshAllMpArticlesRunning = false;
    }
  }

  async getMpInfo(url: string) {
    url = url.trim();
    const account = await this.getAvailableAccount();

    return this.request
      .post<
        {
          id: string;
          cover: string;
          name: string;
          intro: string;
          updateTime: number;
        }[]
      >(
        `/api/v2/platform/wxs2mp`,
        { url },
        {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`,
          },
        },
      )
      .then((res) => res.data);
  }

  async createLoginUrl() {
    return this.request
      .get<{
        uuid: string;
        scanUrl: string;
      }>(`/api/v2/login/platform`)
      .then((res) => res.data);
  }

  async getLoginResult(id: string, timeout = 120 * 1e3) {
    return this.request
      .get<LoginResult>(`/api/v2/login/platform/${id}`, { timeout })
      .then((res) => res.data);
  }
}
