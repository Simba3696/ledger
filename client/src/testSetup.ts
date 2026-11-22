import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only unmounts automatically when vitest's globals are on;
// they're off here, so do it explicitly between tests.
afterEach(() => {
  cleanup();
});
