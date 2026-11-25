import type { ServerConfig } from "../config.ts";
import { postgrest } from "../supabase.ts";

export type AdvisorSummary = {
  id: string;
  slug: string;
  telegramCommand: string;
  displayName: string;
  shortBio: string;
  eraLabel: string;
  domainLabel: string;
  supportedLocales: string[];
  isLaunchEnabled: boolean;
  readinessStatus: string;
};

export type LaunchAdvisorSummary = AdvisorSummary & {
  displayNameKey: string;
};

type AdvisorRow = {
  id: string;
  slug: string;
  telegram_command: string;
  display_name: string;
  display_name_key?: string;
  short_bio: string;
  era_label: string;
  domain_label: string;
  supported_locales: string[];
  is_launch_enabled: boolean;
  readiness_status: string;
};

const LAUNCH_ADVISOR_QUERY = {
  persona_status: "eq.active",
  readiness_status: "eq.advisor_ready",
  is_launch_enabled: "eq.true",
  benchmark_passed_at: "not.is.null"
};

export async function listLaunchEnabledAdvisors(
  config: ServerConfig
): Promise<LaunchAdvisorSummary[]> {
  const rows = await postgrest<AdvisorRow[]>(config, {
    path: "advisors",
    query: {
      select:
        "id,slug,telegram_command,display_name,display_name_key,short_bio,era_label,domain_label,supported_locales,is_launch_enabled,readiness_status",
      ...LAUNCH_ADVISOR_QUERY,
      order: "display_name.asc"
    }
  });

  return rows.map(advisorSummaryFromRow);
}

export async function getLaunchEnabledAdvisorByTelegramCommand(
  config: ServerConfig,
  telegramCommand: string
): Promise<LaunchAdvisorSummary | null> {
  const rows = await postgrest<AdvisorRow[]>(config, {
    path: "advisors",
    query: {
      select:
        "id,slug,telegram_command,display_name,display_name_key,short_bio,era_label,domain_label,supported_locales,is_launch_enabled,readiness_status",
      telegram_command: `eq.${telegramCommand}`,
      ...LAUNCH_ADVISOR_QUERY,
      limit: "1"
    }
  });
  const row = rows[0];

  return row ? advisorSummaryFromRow(row) : null;
}

function advisorSummaryFromRow(row: AdvisorRow): LaunchAdvisorSummary {
  return {
    id: row.id,
    slug: row.slug,
    telegramCommand: row.telegram_command,
    displayName: row.display_name,
    displayNameKey: row.display_name_key ?? normalizeDisplayNameKey(row.display_name),
    shortBio: row.short_bio,
    eraLabel: row.era_label,
    domainLabel: row.domain_label,
    supportedLocales: row.supported_locales,
    isLaunchEnabled: row.is_launch_enabled,
    readinessStatus: row.readiness_status
  };
}

function normalizeDisplayNameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
