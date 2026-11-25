export type ServerConfig = {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
};

export function getServerConfig(): ServerConfig {
  const telegramBotToken = requiredEnv("TELEGRAM_BOT_TOKEN");
  const telegramWebhookSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
  const supabaseSecretKey = requiredEnv("SUPABASE_SECRET_KEY");

  return {
    telegramBotToken,
    telegramWebhookSecret,
    supabaseUrl,
    supabaseSecretKey
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
