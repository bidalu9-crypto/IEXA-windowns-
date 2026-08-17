import { AgentBudgetState } from '../runtime/BudgetManager';
export type AgentStatus = 'idle' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface AgentState { sessionId: string; status: AgentStatus; turn: number; toolCalls: number; startedAt: number; updatedAt: number; currentTool?: { id: string; name: string }; budget?: AgentBudgetState; }
