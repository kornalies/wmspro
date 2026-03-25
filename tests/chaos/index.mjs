import process from "node:process"
import { spawn } from "node:child_process"

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, stdio: "inherit", env: process.env })
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`))
    })
  })
}

async function main() {
  await run("node", ["tests/chaos/isolation.mjs"])
  await run("node", ["tests/chaos/resilience.mjs"])
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
