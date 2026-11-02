declare const LUMIO_VERSION: string;
/** 发布构建时用 `--define LUMIO_VERSION` 写入；开发时为 0.0.0-dev（与其他程序一致）。 */
export const version = typeof LUMIO_VERSION === "string" ? LUMIO_VERSION : "0.0.0-dev";
