import isPropValid from "@emotion/is-prop-valid";
import type { ShouldForwardProp } from "styled-components";

// Privy's modals are built with styled-components v6, which forwards every prop to the DOM
// (its transaction details pass `isActive` to a <div>: a React warning that opens the dev error
// overlay). This restores the v5 behaviour styled-components documents for v6: only valid HTML
// attributes reach DOM elements; components still receive every prop.
export const forwardValidDomProps: ShouldForwardProp<"web"> = (prop, target) =>
  typeof target === "string" ? isPropValid(prop) : true;
