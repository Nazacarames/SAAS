module.exports = {
  apps: [
    {
      name: 'atendechat-backend',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
      META_N8N_WEBHOOK_URL: 'https://lmtmlatam.app.n8n.cloud/webhook/meta-leads',
      META_VERIFY_TOKEN: 'lmtm-meta-kEERBKTh1ZALnUIGDVEmLQ',
        NODE_ENV: 'production',
        PORT: '4000',
        FRONTEND_URL: 'https://login.charlott.ai',

        // DB (Postgres)
        DB_USER: 'atendechat_user',
        DB_PASS: 'Atendechat2026!',
        DB_NAME: 'atendechat',
        DB_HOST: '127.0.0.1',
        DB_PORT: '5432',

        // JWT
        JWT_SECRET: '6c82c99467dbd950b28f917fb215d506479b1bebdf199ca5a3c7bb29323c37df',
        JWT_EXPIRES_IN: '1d',
        JWT_REFRESH_SECRET: 'bdb2c69a419cfd44636b0c27d88aa71dec92aec5b63a3093ae1c3f7b41399114',
        JWT_REFRESH_EXPIRES_IN: '7d',
        INTEGRATIONS_API_KEY: 'mA1thx8RrE-iU5xu0gOkB2x6weSMyqsY'
      }
    }
  ]
}
