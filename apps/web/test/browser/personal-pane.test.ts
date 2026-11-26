import { expect, test } from "bun:test";
import { PersonalPane } from "../../src/client/panes/personal.ts";

test("an unconfigured personal view renders once and recovers after a transient failure", async () => {
  let unavailable = false;
  let renders = 0;
  const state = {
    disposed: false,
    loading: false,
    status: { textContent: "" },
    api: {
      personalView: async () => {
        if (unavailable) throw new Error("fixture connection lost");
        return undefined;
      },
    },
    render() { renders++; },
  };
  const { refresh } = PersonalPane.prototype as unknown as { refresh(this: typeof state): Promise<void> };
  await refresh.call(state);
  await refresh.call(state);
  expect(renders).toBe(1);

  unavailable = true;
  await refresh.call(state);
  expect(state.status.textContent).toBe("Unable to load personal activity.");

  unavailable = false;
  await refresh.call(state);
  expect(renders).toBe(2);
});
