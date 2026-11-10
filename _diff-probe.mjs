
import { classifyAgentCommand } from './index.js'
const W = "D:\\持久层能力架构"
const C = ["Format-Volume -DriveLetter D -Force","Format-Volume -DriveLetter D","format D: /q","Get-ChildItem -Force . | Format-Table","Get-ChildItem -Force 'D:\\x' | Format-Table","Get-ChildItem -Recurse . | Format-Table Name","rg \"format\" src/","Select-String -Path src/index.ts -Pattern \"format\"","Remove-Item -Force .\\tmp\\x.log","Remove-Item -Force 'D:\\other\\x.log'","Remove-Item -Force 'D:\\other\\x.log','D:\\other\\y.log'","Remove-Item .\\tmp\\x.log","Remove-Item 'D:\\other\\x.log'","Remove-Item -Recurse .\\build","Remove-Item -Recurse 'D:\\other'","Copy-Item a.txt b.txt -Force","New-Item -ItemType Directory -Path .\\out -Force","rm -rf /","Remove-Item -Recurse 'C:\\'","Get-ChildItem -Recurse 'C:\\'","del /s /q C:\\","mkfs.ext4 /dev/sda1","diskpart","shutdown -h now"]
for (const command of C) {
  const a = classifyAgentCommand(command, W)
  console.log(JSON.stringify({ command, risk: a.risk }))
}
