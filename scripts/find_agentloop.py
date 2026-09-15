import os

server_ts = r'C:\Users\Administrator\Desktop\iEXA-WIN\src\main\server.ts'
with open(server_ts, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Search for AgentLoop related lines
for i, line in enumerate(lines, 1):
    if 'AgentLoop' in line or 'new agent' in line.lower() or 'agent.' in line:
        print(f'{i}: {line.rstrip()}')