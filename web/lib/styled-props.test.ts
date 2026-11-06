import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StyleSheetManager, styled } from "styled-components";
import { describe, expect, it } from "vitest";
import { forwardValidDomProps } from "./styled-props";

// Same shape as Privy's TransactionDetails: a styled div given a non-DOM `isActive` prop.
const Box = styled.div``;
const box = () => createElement(Box, { isActive: "true", "data-open": "true", id: "x" } as never);

describe("forwardValidDomProps", () => {
  it("without it, styled-components v6 leaks isActive onto the DOM (the Privy warning)", () => {
    expect(renderToStaticMarkup(box())).toContain('isActive="true"');
  });
  it("with it, only valid DOM attributes reach the element", () => {
    const html = renderToStaticMarkup(
      createElement(StyleSheetManager, { shouldForwardProp: forwardValidDomProps }, box()),
    );
    expect(html).not.toMatch(/isactive/i);
    expect(html).toContain('data-open="true"');
    expect(html).toContain('id="x"');
  });
});
