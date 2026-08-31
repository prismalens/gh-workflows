export interface SparklineProps {
  path: string;
  color?: string;
  className?: string;
}

export function Sparkline({ path, color = "#3AA368", className }: SparklineProps) {
  return (
    <svg
      width="96"
      height="20"
      viewBox="0 0 96 20"
      className={className}
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
