import { expect, test } from "bun:test"
import { agyFallbackPaths } from "../src/acp/client.js"

test("Windows fallback includes the per-user agy install location", () => {
  const paths = agyFallbackPaths(
    "win32",
    { LOCALAPPDATA: "C:\\Users\\i\\AppData\\Local" },
    "C:\\Users\\i",
  )
  expect(paths).toContain("C:\\Users\\i\\AppData\\Local\\agy\\bin\\agy.exe")
  expect(paths).toContain("C:\\Users\\i\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe")
})

test("POSIX fallback includes the usual install locations", () => {
  const paths = agyFallbackPaths("linux", {}, "/home/i")
  expect(paths).toEqual([
    "/home/i/.local/bin/agy",
    "/home/i/bin/agy",
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/opt/Antigravity/bin/agy",
    "/usr/bin/agy",
  ])
})
