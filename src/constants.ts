import packageJson from "../package.json" with { type: "json" };

export const PACKAGE_VERSION = packageJson.version;
export const ACP_SDK_VERSION = packageJson.dependencies["@agentclientprotocol/sdk"];
export const ACP_PROTOCOL_VERSION = 1;
export const MANAGED_AUTH_MARKER = "pi-antigravity-acp:managed-by-antigravity";
export const PERMISSION_TOOL_NAME = "antigravity_acp_permission";
export const PERMISSION_RESULT_KIND = "pi-antigravity-acp-permission-v1";
export const QUOTA_REQUEST_CHANNEL = "antigravity-acp:quota:request";
export const DEFAULT_MAX_BINDINGS = 4;
export const DEFAULT_BINDING_IDLE_MS = 5 * 60_000;
