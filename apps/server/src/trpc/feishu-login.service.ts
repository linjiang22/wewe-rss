import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import Axios, { AxiosInstance } from 'axios';
import * as QRCode from 'qrcode';

type FeishuConfig = ConfigurationType['feishu'];

@Injectable()
export class FeishuLoginService {
  private readonly logger = new Logger(this.constructor.name);
  private readonly request: AxiosInstance;
  private tenantAccessToken = '';
  private tenantAccessTokenExpiresAt = 0;

  constructor(private readonly configService: ConfigService) {
    const { baseUrl } = this.getConfig();
    this.request = Axios.create({ baseURL: baseUrl, timeout: 15 * 1e3 });
  }

  isEnabled() {
    const { appId, appSecret, receiveId } = this.getConfig();
    return Boolean(appId && appSecret && receiveId);
  }

  async sendLoginCard({
    accountId,
    uuid,
    scanUrl,
  }: {
    accountId: string;
    uuid: string;
    scanUrl: string;
  }) {
    if (!this.isEnabled()) {
      this.logger.warn('Feishu login card is disabled');
      return;
    }

    const qrImage = await this.createQrImage(scanUrl);
    const imageKey = await this.uploadImage(qrImage);
    await this.sendInteractiveCard({
      accountId,
      imageKey,
      uuid,
    });
  }

  private getConfig() {
    return this.configService.get<FeishuConfig>('feishu')!;
  }

  private async getTenantAccessToken() {
    const now = Date.now();
    if (
      this.tenantAccessToken &&
      this.tenantAccessTokenExpiresAt - now > 60 * 1e3
    ) {
      return this.tenantAccessToken;
    }

    const { appId, appSecret } = this.getConfig();
    const res = await this.request
      .post<{
        code: number;
        msg?: string;
        tenant_access_token?: string;
        expire?: number;
      }>('/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: appId,
        app_secret: appSecret,
      })
      .then((res) => res.data);

    if (res.code !== 0 || !res.tenant_access_token) {
      throw new Error(`get tenant_access_token failed: ${res.msg || res.code}`);
    }

    this.tenantAccessToken = res.tenant_access_token;
    this.tenantAccessTokenExpiresAt = now + (res.expire || 7200) * 1e3;
    return this.tenantAccessToken;
  }

  private async createQrImage(scanUrl: string) {
    return QRCode.toBuffer(scanUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 180,
    });
  }

  private async uploadImage(image: Buffer) {
    const token = await this.getTenantAccessToken();
    const { body, boundary } = this.createImageUploadBody(image);

    const res = await this.request
      .post<{
        code: number;
        msg?: string;
        data?: {
          image_key?: string;
        };
      }>('/open-apis/im/v1/images', body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
      })
      .then((res) => res.data);

    const imageKey = res.data?.image_key;
    if (res.code !== 0 || !imageKey) {
      throw new Error(`upload feishu image failed: ${res.msg || res.code}`);
    }

    return imageKey;
  }

  private createImageUploadBody(image: Buffer) {
    const boundary = `----wewe-rss-feishu-${Date.now()}`;
    const chunks = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="weread-login.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];

    return {
      boundary,
      body: Buffer.concat(chunks),
    };
  }

  private async sendInteractiveCard({
    accountId,
    imageKey,
    uuid,
  }: {
    accountId: string;
    imageKey: string;
    uuid: string;
  }) {
    const token = await this.getTenantAccessToken();
    const { receiveId, receiveIdType } = this.getConfig();
    const card = this.createLoginCard({ accountId, imageKey, uuid });

    const res = await this.request
      .post<{
        code: number;
        msg?: string;
      }>(
        '/open-apis/im/v1/messages',
        {
          receive_id: receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
        {
          params: { receive_id_type: receiveIdType },
          headers: { Authorization: `Bearer ${token}` },
        },
      )
      .then((res) => res.data);

    if (res.code !== 0) {
      throw new Error(`send feishu login card failed: ${res.msg || res.code}`);
    }
  }

  private createLoginCard({
    accountId,
    imageKey,
    uuid,
  }: {
    accountId: string;
    imageKey: string;
    uuid: string;
  }) {
    const { originUrl } =
      this.configService.get<ConfigurationType['feed']>('feed')!;

    const elements: any[] = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**微信读书账号 ${accountId} 登录失效**\n请使用微信扫描下方二维码重新登录。`,
        },
      },
      {
        tag: 'img',
        img_key: imageKey,
        alt: {
          tag: 'plain_text',
          content: '微信扫码登录二维码',
        },
        mode: 'fit_horizontal',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `二维码有效期较短。登录成功后会自动保存账号并触发全部更新。登录任务：${uuid}`,
          },
        ],
      },
    ];

    if (originUrl) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '打开账号管理',
            },
            type: 'primary',
            url: `${originUrl}/accounts`,
          },
        ],
      });
    }

    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'red',
        title: {
          tag: 'plain_text',
          content: 'WeWe RSS 账号登录失效',
        },
      },
      elements,
    };
  }
}
