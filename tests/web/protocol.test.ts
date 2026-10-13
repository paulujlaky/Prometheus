import { expect, test } from "bun:test";

import { parseQuestion, splitAttached } from "../../web/Lib/protocol";

test("a question reads its choices and write-in", () => {

  expect(parseQuestion("Which one?\n- The 7:05\n2. The 9:40\n+ Other")).toEqual({ prompt: "Which one?", choices: ["The 7:05", "The 9:40"], write: "Other" });

});

test("a message's [attached] lines come apart from its words, as protocol.Attached reads them", () => {

  expect(splitAttached("Apply with these\n\n[attached]\nuploads/cv.pdf\nuploads/photo.png")).toEqual({ text: "Apply with these", files: ["uploads/cv.pdf", "uploads/photo.png"] });
  expect(splitAttached("[attached]\nuploads/cv.pdf")).toEqual({ text: "", files: ["uploads/cv.pdf"] });
  expect(splitAttached("Just words")).toEqual({ text: "Just words", files: [] });

});
