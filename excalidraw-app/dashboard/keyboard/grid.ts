export type Direction = "up" | "down" | "left" | "right";

/**
 * Where a grid cursor lands after a motion. Nothing wraps: `l` at the end of
 * a row stops, `j` past the last row clamps to the last card, as in vim.
 * With no cursor yet, any motion lands on the first card.
 */
export const moveIndex = (
  index: number | null,
  count: number,
  columns: number,
  direction: Direction,
): number | null => {
  if (count <= 0) {
    return null;
  }
  if (index === null || index < 0 || index >= count) {
    return 0;
  }
  const cols = Math.max(1, columns);
  switch (direction) {
    case "left":
      return index % cols === 0 ? index : index - 1;
    case "right":
      return index % cols === cols - 1 || index === count - 1
        ? index
        : index + 1;
    case "up":
      return index - cols >= 0 ? index - cols : index;
    case "down":
      if (index + cols < count) {
        return index + cols;
      }
      return Math.floor(index / cols) === Math.floor((count - 1) / cols)
        ? index
        : count - 1;
    default:
      return index;
  }
};

/** Column count of a CSS grid, read from its resolved template. */
export const columnsOf = (grid: HTMLElement | null): number => {
  if (!grid) {
    return 1;
  }
  const template = getComputedStyle(grid).gridTemplateColumns;
  const columns = template.split(" ").filter((part) => part && part !== "0px");
  return Math.max(1, columns.length);
};
