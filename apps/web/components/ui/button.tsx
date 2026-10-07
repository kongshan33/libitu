import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "danger-solid" | "record";
type Appearance = {
  variant?: ButtonVariant;
  /** `inherit` preserves existing feature geometry during migration. */
  size?: "sm" | "md" | "lg" | "inherit";
  shape?: "default" | "pill" | "circle";
  recording?: boolean;
  className?: string;
};

export function buttonAppearance({ variant = "secondary", size = "md", shape = "default", recording = false, className }: Appearance = {}) {
  return {
    className: ["ui-button", className].filter(Boolean).join(" "),
    "data-variant": variant,
    "data-size": size,
    "data-shape": shape,
    "data-recording": recording || undefined
  };
}

type ButtonProps = ComponentProps<"button"> & Appearance & {
  loading?: boolean;
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

/** Keep children as the idle label: the loading overlay never changes its footprint. */
export function Button({ variant, size, shape, recording, className, loading, loadingLabel = "Loading…",
  leadingIcon, trailingIcon, children, disabled, type = "button", ...props }: ButtonProps) {
  const content = <>{leadingIcon}{children}{trailingIcon}</>;
  return <button {...props} {...buttonAppearance({ variant, size, shape, recording, className })}
    type={type} disabled={disabled || loading} aria-busy={loading || props["aria-busy"]}
    aria-label={loading ? loadingLabel : props["aria-label"]} data-loading={loading || undefined}>
    {loading !== undefined ? <>
      <span className="ui-button-label" aria-hidden={loading || undefined}>{content}</span>
      {loading ? <span className="ui-button-progress" aria-hidden="true"><span className="ui-button-spinner" /><span>{loadingLabel}</span></span> : null}
    </> : content}
  </button>;
}

/** Navigation remains a real Next link, including modified clicks and prefetch. */
export function ButtonLink({ variant, size, shape, recording, className, ...props }: ComponentProps<typeof Link> & Appearance) {
  return <Link {...props} {...buttonAppearance({ variant, size, shape, recording, className })} />;
}
