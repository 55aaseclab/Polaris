export interface FloatingButtonBounds {
  viewportWidth: number;
  viewportHeight: number;
  elementWidth: number;
  elementHeight: number;
  margin: number;
}

export interface FloatingButtonPosition {
  x: number;
  y: number;
}

export function didFloatingButtonDrag(
  input: {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  },
  threshold: number,
): boolean {
  return (
    Math.abs(input.currentX - input.startX) > threshold
    || Math.abs(input.currentY - input.startY) > threshold
  );
}

export function clampFloatingButtonPosition(
  input: FloatingButtonPosition,
  bounds: FloatingButtonBounds,
): FloatingButtonPosition {
  const maxX = Math.max(bounds.margin, bounds.viewportWidth - bounds.elementWidth - bounds.margin);
  const maxY = Math.max(bounds.margin, bounds.viewportHeight - bounds.elementHeight - bounds.margin);
  return {
    x: Math.min(Math.max(input.x, bounds.margin), maxX),
    y: Math.min(Math.max(input.y, bounds.margin), maxY),
  };
}

export function defaultFloatingButtonPosition(
  bounds: FloatingButtonBounds,
): FloatingButtonPosition {
  return clampFloatingButtonPosition(
    {
      x: bounds.margin,
      y: bounds.viewportHeight - bounds.elementHeight - bounds.margin,
    },
    bounds,
  );
}
