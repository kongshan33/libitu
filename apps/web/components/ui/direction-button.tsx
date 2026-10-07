import type { ComponentProps } from "react";
import { Button, ButtonLink } from "./button";

/** Back/next actions share one 40px control and 16px icon scale across workflows. */
export function DirectionButton(props: Omit<ComponentProps<typeof Button>, "size" | "shape">) {
  return <Button {...props} size="md" shape="default" />;
}
export function DirectionLink(props: Omit<ComponentProps<typeof ButtonLink>, "size" | "shape">) {
  return <ButtonLink variant="secondary" {...props} size="md" shape="default" />;
}
