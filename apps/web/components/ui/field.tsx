import type { ComponentProps } from "react";

type Appearance = { appearance?: "control" | "bare"; shape?: "default" | "pill" };
function fieldClass(className?: string) { return ["ui-field", className].filter(Boolean).join(" "); }

/** Feature classes own dimensions; shared fields own paint and interaction states. */
export function Input({ className, appearance = "control", shape = "default", ...props }: ComponentProps<"input"> & Appearance) {
  return <input {...props} className={fieldClass(className)} data-field={appearance} data-shape={shape} />;
}
export function Textarea({ className, appearance = "control", shape = "default", ...props }: ComponentProps<"textarea"> & Appearance) {
  return <textarea {...props} className={fieldClass(className)} data-field={appearance} data-shape={shape} />;
}
