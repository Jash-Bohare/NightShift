import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "default" | "ink" | "orange";
type ButtonSize = "default" | "small";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  className = "",
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  const classes = [
    "button",
    `button--${variant}`,
    size === "small" ? "button--small" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button className={classes} {...props} />;
}
