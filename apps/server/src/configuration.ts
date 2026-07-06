const configuration = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const port = process.env.PORT || 4000;
  const host = process.env.HOST || '0.0.0.0';

  const maxRequestPerMinute = parseInt(
    `${process.env.MAX_REQUEST_PER_MINUTE}|| 60`,
  );

  const authCode = process.env.AUTH_CODE;
  const platformUrl = process.env.PLATFORM_URL || 'https://weread.111965.xyz';
  const originUrl = process.env.SERVER_ORIGIN_URL || '';
  const feishuBaseUrl = process.env.FEISHU_BASE_URL || 'https://open.feishu.cn';

  const feedMode = process.env.FEED_MODE as 'fulltext' | '';

  const databaseType = process.env.DATABASE_TYPE || 'mysql';

  const updateDelayTime = parseInt(`${process.env.UPDATE_DELAY_TIME} || 60`);

  const enableCleanHtml = process.env.ENABLE_CLEAN_HTML === 'true';
  return {
    server: { isProd, port, host },
    throttler: { maxRequestPerMinute },
    auth: { code: authCode },
    platform: { url: platformUrl },
    feishu: {
      baseUrl: feishuBaseUrl,
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      receiveId: process.env.FEISHU_RECEIVE_ID || '',
      receiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE || 'chat_id',
    },
    feed: {
      originUrl,
      mode: feedMode,
      updateDelayTime,
      enableCleanHtml,
    },
    database: {
      type: databaseType,
    },
  };
};

export default configuration;

export type ConfigurationType = ReturnType<typeof configuration>;
