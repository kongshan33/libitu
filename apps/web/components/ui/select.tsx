"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={classes("ui-select-trigger ui-field", className)} data-field="control" data-shape="default" {...props}>
    {children}
    <SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", sideOffset = 6, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content ref={ref} className={classes("ui-select-content", className)} position={position} sideOffset={sideOffset} {...props}>
      <SelectPrimitive.ScrollUpButton className="ui-select-scroll-button">
        <ChevronUp aria-hidden="true" />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="ui-select-viewport">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="ui-select-scroll-button">
        <ChevronDown aria-hidden="true" />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={classes("ui-select-item", className)} {...props}>
    <span className="ui-select-item-indicator">
      <SelectPrimitive.ItemIndicator><Check aria-hidden="true" /></SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;


type SelectOption = { value: string; label: string; disabled?: boolean };
/** Encode option values so a real empty-value choice (All sources) works with Radix. */
export function SelectField({ value, onValueChange, options, disabled, name, ...triggerProps }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  name?: string;
} & Omit<React.ComponentPropsWithoutRef<typeof SelectTrigger>, "value" | "onChange" | "children" | "name">) {
  return <Select value={`option:${value}`} onValueChange={next => onValueChange(next.slice(7))} disabled={disabled}>
    {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
    <SelectTrigger {...triggerProps}><SelectValue /></SelectTrigger>
    <SelectContent align="start">
      {options.map(option => <SelectItem key={option.value} value={`option:${option.value}`} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
