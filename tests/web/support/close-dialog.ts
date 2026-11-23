import { expect } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";

/**
 * The Close dialog reads Code's Close preview before it offers a send (DEC 254zzz367), so its button is disabled until that answer is served.
 * Press it only once it is enabled, never on the first paint.
 */
export async function pressWhenEnabled(find: () => HTMLElement | Promise<HTMLElement>): Promise<void> {
 const button = await find() as HTMLButtonElement;
 await waitFor(() => expect(button.disabled).toBe(false));
 fireEvent.click(button);
}
