/**
 * 浏览器入口（ADR 0026）：实例化应用、恢复会话并挂载视图。
 */
import { App } from "./app.ts";

const root = document.getElementById("app");
if (!root) throw new Error("#app 元素不存在");

const app = new App(root);
app.mount();
