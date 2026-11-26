import { describe, expect, it } from "vitest";
import { confirmsPermissionMode, permissionModeId } from "../src/acp/permission-policy.js";
import type { SessionState } from "../src/acp/session-state.js";

function state(ids: string[], current = ids[0]!): SessionState {
	return { modes: { currentModeId: current, availableModes: ids.map((id) => ({ id, name: id })) } };
}

describe("permission policy resolution", () => {
	it("prefers an exact mode over the edit-policy alias", () => {
		expect(permissionModeId(state(["accept-edits", "auto_edit"]), "auto_edit")).toBe("auto_edit");
	});

	it("does not invent permission semantics for auto or plan", () => {
		for (const policy of ["default", "auto_edit", "yolo"] as const) {
			expect(permissionModeId(state(["auto", "plan"]), policy)).toBeUndefined();
		}
	});

	it("requires both advertisement and exact current-mode confirmation", () => {
		expect(confirmsPermissionMode(state(["default", "accept-edits"], "accept-edits"), "auto_edit", "accept-edits")).toBe(true);
		expect(confirmsPermissionMode(state(["default", "accept-edits"], "default"), "auto_edit", "accept-edits")).toBe(false);
		expect(confirmsPermissionMode(state(["default"], "accept-edits"), "auto_edit", "accept-edits")).toBe(false);
		expect(permissionModeId({}, "default")).toBeUndefined();
	});
});
