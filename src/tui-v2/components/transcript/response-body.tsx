/** @jsxImportSource @opentui/react */

import { Fragment, useMemo, type ReactNode } from "react";
import { markdownParts } from "../../../ui-core/rendering/markdown.js";
import type { TableColumn, TableGridRow } from "../../../ui-core/rendering/markdown/tables.js";
import { styleAnsiLine, styledLinesWeight, type StyledLine, type StyledMarkdownOptions } from "../../rendering/styled-markdown.js";
import { registerCellFragment, registerTableRow } from "./table-cell-selection.js";
import { StyledTextBlock } from "./styled-text-block.js";

export type ResponsePart = StyledLine | TableGridRow;

export function responseParts(text: string, options: StyledMarkdownOptions): ResponsePart[] {
  return Array.from(markdownParts(text.replace(/\n+$/, ""), options.width, options), part =>
    typeof part === "string" ? styleAnsiLine(part || " ", options.defaultFg) : part);
}

export function responseWeight(parts: ResponsePart[]): number {
  let weight = 0;
  for (const part of parts) {
    if ("chunks" in part) weight += styledLinesWeight([part]);
    else for (const cell of part.columns) {
      for (const piece of cell.pieces) weight += 128 + 2 * (piece.rendered.length + piece.before.length);
    }
  }
  return weight;
}

function Cell({ column, foreground }: { column: TableColumn; foreground: string }): ReactNode {
  return <box style={{ width: column.width + 2, flexDirection: "column", flexShrink: 0 }}>
    {column.pieces.map((piece, index) => <text key={index}
      ref={node => registerCellFragment(node, column, index)}
      selectable={piece.width > 0} wrapMode="none" content={styleAnsiLine(piece.rendered, foreground)}
      style={{ marginLeft: 1 + piece.inset, width: Math.max(1, piece.width), height: 1 }}
    />)}
  </box>;
}

function GridRow({ row, foreground }: { row: TableGridRow; foreground: string }): ReactNode {
  const divider = styleAnsiLine(Array(row.height).fill(row.divider).join("\n"), foreground);
  const rule = <text selectable={false} wrapMode="none" content={divider} style={{ width: 1, height: row.height }} />;
  return <box ref={registerTableRow} style={{ flexDirection: "row", height: row.height, flexShrink: 0 }}>
    {rule}
    {row.columns.map((column, index) => <Fragment key={index}>
      <Cell column={column} foreground={foreground} />{rule}
    </Fragment>)}
  </box>;
}

export function ResponseBody({ parts, foreground, background }: {
  parts: ResponsePart[]; foreground: string; background: string;
}): ReactNode {
  return useMemo(() => {
    const blocks: ReactNode[] = [];
    let lines: StyledLine[] = [];
    const flush = () => {
      if (lines.length) blocks.push(<StyledTextBlock key={blocks.length} lines={lines} background={background} />);
      lines = [];
    };
    for (const part of parts) {
      if ("chunks" in part) { lines.push(part); continue; }
      flush();
      blocks.push(<GridRow key={blocks.length} row={part} foreground={foreground} />);
    }
    flush();
    return blocks;
  }, [parts, foreground, background]);
}
