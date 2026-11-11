import { clear, field, h, select, toast } from "./dom.ts";
import { BUTTONS, DEFAULT_BINDINGS, PAD_COMMANDS, remap, type GamepadInput, type PadBindings, type PadCommand, type PadStatus, type PadSample } from "./gamepad-input.ts";
import { t } from "./i18n.ts";

export const PAD_LABELS: Record<PadCommand, string> = {
  up: "Move up", down: "Move down", left: "Move left", right: "Move right", activate: "Open / primary action",
  back: "Back / leave input", delegate: "Delegate / reject", more: "More actions", previous: "Previous section", next: "Next section",
  view: "Notification action", palette: "Command menu", talk: "Hold to talk (G1-4)",
};

export function padButtonLabel(index: number, pad?: PadSample): string {
  return ((!pad || pad.mapping === "standard") && BUTTONS[index]) || t("Button {0}", index + 1);
}

export class GamepadSettings {
  readonly element = h("div", { class: "gamepad-settings" });
  private status = h("p", { role: "status" });
  private readout = h("pre", { class: "code-block pad-readout" });
  private mappings = h("div", { class: "pad-mappings" });
  private unsubscribe: () => void;
  private testing = false;
  private pad?: PadSample;
  private test = h("button", { type: "button", class: "btn btn-small", onclick: () => this.toggleTest() }, t("Test gamepad"));

  constructor(private input: GamepadInput) {
    this.element.append(this.status,
      h("p", { class: "muted" }, t("Connect a controller and press a button. Left stick moves focus. Right stick scrolls. Hold a dangerous action for one second. RT speech requires G1-4.")),
      h("div", { class: "button-row" }, this.test, h("button", { type: "button", class: "btn btn-small", onclick: () => {
        this.configure({ ...DEFAULT_BINDINGS });
      } }, t("Restore defaults"))), this.readout, this.mappings);
    this.renderMappings();
    this.unsubscribe = input.subscribe(status => this.update(status));
  }

  dispose(): void { this.unsubscribe(); this.element.removeAttribute("data-pad-testing"); }

  private toggleTest(): void {
    this.testing = !this.testing;
    this.element.toggleAttribute("data-pad-testing", this.testing);
    this.test.textContent = t(this.testing ? "Stop testing" : "Test gamepad");
    this.input.configure(this.input.mapping);
  }

  private update(status: PadStatus): void {
    const previous = this.pad;
    this.pad = status.pad;
    if (previous?.mapping !== this.pad?.mapping || previous?.buttons.length !== this.pad?.buttons.length) this.renderMappings();
    const message = status.state === "unavailable"
      ? t("Gamepad API unavailable. Try HTTPS or a supported browser.")
      : !status.pad ? t("Waiting for a controller. Press a button to connect.")
      : status.pad.mapping === "standard" ? t("Connected: {0}", status.pad.id)
      : t("This controller’s buttons may be mismatched. You can remap them in Settings → General → Gamepad.");
    if (message !== this.status.textContent) this.status.textContent = message;
    if (this.testing && !this.element.hasAttribute("data-pad-testing")) {
      this.testing = false;
      this.test.textContent = t("Test gamepad");
    }
    this.readout.hidden = !status.pad;
    if (!status.pad) return;
    const { buttons, axes } = status.pad;
    const pressed = buttons.flatMap((down, index) => down ? [padButtonLabel(index, status.pad)] : []);
    const readout = t("Buttons: {0}", pressed.join(" · ") || "—") + "\n" + t("Axes: {0}", axes.map(value => value.toFixed(2)).join(" · "));
    if (this.readout.textContent !== readout) this.readout.textContent = readout;
  }

  private configure(bindings: PadBindings): void {
    if (!this.input.configure(bindings)) toast(t("Gamepad mapping could not be saved. It will reset after a refresh."), "error");
    this.renderMappings();
  }

  private renderMappings(): void {
    clear(this.mappings, ...PAD_COMMANDS.map(command => {
      const current = this.input.mapping[command];
      const indexes = Array.from({ length: this.pad?.buttons.length ?? BUTTONS.length }, (_, index) => index);
      if (!indexes.includes(current)) indexes.push(current);
      const control = select(command, indexes.map(index => [String(index), padButtonLabel(index, this.pad)]), String(current));
      control.addEventListener("change", () => this.configure(remap(this.input.mapping, command, Number(control.value))));
      return field(t(PAD_LABELS[command]), control);
    }));
  }
}
