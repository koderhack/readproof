import React from "react";
import { createPortal } from "react-dom";

export function PrintPortal({ children }) {
  return createPortal(<div className="print-root">{children}</div>, document.body);
}