import { text } from "./messages.ts";
import { healthVersion as health, extraServices as extra, publicHubChecks as publicChecks } from "@lumio/platform";
export const healthVersion = (body: Parameters<typeof health>[0]) => health(body, text);
export const extraServices = (io: Parameters<typeof extra>[0]) => extra({ ...io, text });
export const publicHubChecks = (io: Parameters<typeof publicChecks>[0], url: string, expected: string, port: number) => publicChecks({ ...io, text }, url, expected, port);
