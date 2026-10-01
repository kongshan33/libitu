"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type Props = {
  label: string;
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onValueChange: (value: string) => void;
};

export function StageTwoSelect({ label, ariaLabel, value, options, disabled = false, onValueChange }: Props) {
  return (
    <div className="stage-two-select">
      <span className="stage-two-select-label">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={onValueChange}>
        <SelectTrigger aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" sideOffset={5}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
