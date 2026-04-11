export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDate(dateString?: string): string {
  if (!dateString) {
    return "Unavailable";
  }

  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function formatRelativeDate(dateString?: string): string {
  if (!dateString) {
    return "No recent activity";
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return "No recent activity";
  }

  const deltaMs = Date.now() - date.getTime();
  const deltaDays = Math.max(0, Math.round(deltaMs / (1000 * 60 * 60 * 24)));

  if (deltaDays <= 1) {
    return "Updated today";
  }

  if (deltaDays < 30) {
    return `Updated ${deltaDays} days ago`;
  }

  const deltaMonths = Math.round(deltaDays / 30);
  return `Updated ${deltaMonths} months ago`;
}

export function truncate(value: string, maxLength = 64): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
