interface AppIconProps {
  className?: string;
}

export function AppIcon({ className = "h-8 w-8" }: AppIconProps) {
  return (
    <img
      src="/icons/icon-64.png"
      alt="NW Config Manager"
      className={className}
      width={32}
      height={32}
    />
  );
}
