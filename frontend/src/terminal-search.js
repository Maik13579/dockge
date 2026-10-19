/** Read logical lines, preserving the terminal columns behind UTF-16 text offsets. */
function* logicalLines(terminal) {
    const buffer = terminal.buffer.active;
    const cell = buffer.getNullCell();
    let text = "";
    let starts = [];
    let ends = [];
    for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        const next = buffer.getLine(row + 1);
        const wrapped = !!next?.isWrapped;
        let columns = Math.min(line.length, terminal.cols);
        // A wide character can wrap with an unused cell at the end of its previous row.
        if (wrapped && !line.getCell(columns - 1)?.getChars() && next.getCell(0)?.getWidth() === 2) {
            columns--;
        }
        const value = line.translateToString(!wrapped, 0, columns);
        let offset = 0;
        for (let column = 0; column < columns && offset < value.length; column++) {
            line.getCell(column, cell);
            if (cell.getWidth() === 0) {
                continue;
            }
            const chars = cell.getChars() || " ";
            for (let index = 0; index < chars.length && offset < value.length; index++, offset++) {
                starts.push(row * terminal.cols + column);
                ends.push(row * terminal.cols + column + cell.getWidth());
            }
        }
        text += value;
        if (!wrapped) {
            yield { text,
                starts,
                ends };
            text = "";
            starts = [];
            ends = [];
        }
    }
}

/** Find literal, case-insensitive text in retained scrollback and wrap at either end. */
export function searchTerminal(terminal, query, { backwards = false, restart = false } = {}) {
    if (!terminal) {
        return false;
    }
    if (!query) {
        terminal.clearSelection();
        return false;
    }
    const selection = restart ? undefined : terminal.getSelectionPosition()?.start;
    const anchor = selection ? selection.y * terminal.cols + selection.x : undefined;
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let candidate;
    let fallback;
    for (const line of logicalLines(terminal)) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line.text))) {
            const start = line.starts[match.index];
            const end = line.ends[match.index + match[0].length - 1];
            const result = { start,
                length: end - start };
            if (backwards) {
                fallback = result;
                if (anchor === undefined || start < anchor) {
                    candidate = result;
                }
            } else {
                fallback ??= result;
                if (!candidate && (anchor === undefined || start > anchor)) {
                    candidate = result;
                }
            }
        }
    }
    const result = candidate || fallback;
    if (!result) {
        terminal.clearSelection();
        return false;
    }
    const row = Math.floor(result.start / terminal.cols);
    terminal.select(result.start % terminal.cols, row, result.length);
    terminal.scrollToLine(Math.max(0, row - Math.floor(terminal.rows / 2)));
    return true;
}
