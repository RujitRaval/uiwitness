import {
  CheckError,
  ConfigDiscoveryError,
  ConfigLoadError,
  DEFAULT_CONFIG_FILENAMES,
  checkPublicSite,
  createGuardShardPlan,
  discoverConfig,
  defineConfig,
  initProject,
  loadConfig,
  openReport,
  runCli,
  runGuardShard,
  GuardError,
  scanProject,
  InitError,
  OpenReportError,
  ScanError,
  type CheckErrorCode,
  type CheckDiscovery,
  type CheckOptions,
  type CheckResult,
  type ConfigDiscoveryErrorCode,
  type ConfigDiscoveryOptions,
  type ConfigLoadErrorCode,
  type LoadedConfig,
  type CliExitCode,
  type InitErrorCode,
  type InitOptions,
  type InitResult,
  type GuardShardOptions,
  type GuardShardPlanOptions,
  type GuardShardPlanResult,
  type GuardShardResult,
  type GuardErrorCode,
  type OpenReportErrorCode,
  type OpenReportOptions,
  type OpenReportResult,
  type PublicSiteSetupResult,
  type RunCliOptions,
  type ScanErrorCode,
  type ScanOptions,
  type ScanResult,
} from "uiwitness";

const checkOptions: CheckOptions = {
  cwd: "/tmp/example",
  headed: false,
  maxPages: 5,
  url: "https://example.com",
  writeConfig: true,
};
const checkResult: Promise<CheckResult> = checkPublicSite(checkOptions);
const checkDiscovery: Promise<CheckDiscovery> = checkResult.then(
  (result) => result.discovery,
);
const publicSiteSetup: Promise<PublicSiteSetupResult | undefined> =
  checkResult.then((result) => result.setup);
const checkCode: CheckErrorCode = "CHECK_DISCOVERY_FAILED";
const checkRootCode: CheckErrorCode = "CHECK_ROOT_INVALID";
const checkError: Error = new CheckError(checkCode, "Discovery failed.");

const options: ConfigDiscoveryOptions = {
  configPath: "./config/uiwitness.config.mjs",
  cwd: "/tmp/example",
};
const configPath: Promise<string> = discoverConfig(options);
const loadedConfig: Promise<LoadedConfig> = loadConfig(options);
const discoveryCode: ConfigDiscoveryErrorCode = "CONFIG_NOT_FOUND";
const loadCode: ConfigLoadErrorCode = "CONFIG_IMPORT_FAILED";
const filenames: readonly string[] = DEFAULT_CONFIG_FILENAMES;
const discoveryError: Error = new ConfigDiscoveryError(
  discoveryCode,
  "Config missing.",
);
const loadError: Error = new ConfigLoadError(
  loadCode,
  "Config failed.",
  "/tmp/example/uiwitness.config.mjs",
);
const initOptions: InitOptions = { cwd: "/tmp/example" };
const initResult: Promise<InitResult> = initProject(initOptions);
const initCode: InitErrorCode = "INIT_CONFLICT";
const initError: Error = new InitError(initCode, "Already exists.");
const openOptions: OpenReportOptions = { cwd: "/tmp/example" };
const openResult: Promise<OpenReportResult> = openReport(openOptions);
const openCode: OpenReportErrorCode = "OPEN_REPORT_NOT_FOUND";
const openError: Error = new OpenReportError(
  openCode,
  "Report missing.",
  "/tmp/example/.uiwitness/report/index.html",
);
const cliOptions: RunCliOptions = {
  args: ["init"],
  stdout: (message) => void message,
};
const cliResult: Promise<CliExitCode> = runCli(cliOptions);
const scanOptions: ScanOptions = {
  coordinate: "home/success/desktop/light",
  configPath: "./config/uiwitness.config.mjs",
  cwd: "/tmp/example",
  headed: false,
};
const scanResult: Promise<ScanResult> = scanProject(scanOptions);
const shardPlanOptions: GuardShardPlanOptions = {
  cwd: "/tmp/example",
  outPath: ".uiwitness/shard-plan.json",
  shards: 4,
  ttlMinutes: 60,
};
const shardPlanResult: Promise<GuardShardPlanResult> =
  createGuardShardPlan(shardPlanOptions);
const shardOptions: GuardShardOptions = {
  cwd: "/tmp/example",
  shard: "1/4",
  shardPlanPath: ".uiwitness/shard-plan.json",
};
const shardResult: Promise<GuardShardResult> = runGuardShard(shardOptions);
const guardCode: GuardErrorCode = "GUARD_SHARD_PLAN_MISMATCH";
const guardError: Error = new GuardError(guardCode, "Plan mismatch.");
const htmlReportPath: Promise<".uiwitness/report/index.html"> = scanResult.then(
  (result) => result.htmlReportPath,
);
const scanCode: ScanErrorCode = "SCAN_ROUTE_NOT_FOUND";
const coordinateCode: ScanErrorCode = "SCAN_COORDINATE_NOT_FOUND";
const scanError: Error = new ScanError(scanCode, "Route missing.", "missing");
const typedConfig = defineConfig({
  baseURL: "http://localhost:3000",
  routes: [
    { id: "home", path: "/", states: [{ id: "success", setup: "./success.ts" }] },
  ],
  themes: ["light"],
  viewports: { desktop: { height: 800, width: 1200 } },
});

void configPath;
void checkResult;
void checkDiscovery;
void publicSiteSetup;
void checkError;
void checkRootCode;
void loadedConfig;
void filenames;
void discoveryError;
void loadError;
void initResult;
void initError;
void openResult;
void openError;
void cliResult;
void scanResult;
void shardPlanResult;
void shardResult;
void guardError;
void htmlReportPath;
void scanError;
void coordinateCode;
void typedConfig;

discoverConfig({
  // @ts-expect-error Config paths must be strings.
  configPath: 42,
});
