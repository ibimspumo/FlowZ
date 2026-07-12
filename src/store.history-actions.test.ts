import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ activate: vi.fn(async()=>undefined), remove: vi.fn(async()=>1) }));
vi.mock('./persistence/library', async (original) => ({
  ...(await original<typeof import('./persistence/library')>()),
  setActiveLibraryResult: persistence.activate,
  deleteLibraryResult: persistence.remove,
}));
import { useFlowStore } from './store';

const history = [
  {id:'old',runId:'run-old',createdAt:'2026-01-01T00:00:00Z',value:'Alt',persisted:true,active:false},
  {id:'new',runId:'run-new',createdAt:'2026-01-02T00:00:00Z',value:'Neu',persisted:true,active:true},
];

describe('persisted history actions',()=>{
  beforeEach(async()=>{persistence.activate.mockClear();persistence.remove.mockClear();await useFlowStore.getState().initialize();useFlowStore.getState().reset();});
  it('activates without structural undo and rebuilds typed scalar output',async()=>{
    const id=useFlowStore.getState().addNode('textGeneration');
    useFlowStore.getState().updateNode(id,{status:'fresh',value:'Neu',history,outputValues:{text:'Neu'},persisted:true});
    const undoBefore=useFlowStore.getState().canUndo;
    expect(await useFlowStore.getState().activateHistoryResult(id,'old')).toBe(true);
    expect(persistence.activate).toHaveBeenCalledWith(expect.any(String),id,'old');
    const data=useFlowStore.getState().nodes.find(node=>node.id===id)!.data;
    expect(data.value).toBe('Alt');expect(data.outputValues).toEqual({text:'Alt'});expect(data.history?.find(item=>item.id==='old')?.active).toBe(true);
    expect(useFlowStore.getState().canUndo).toBe(undoBefore);
  });
  it('refuses active deletion and removes inactive history from shared truth',async()=>{
    const id=useFlowStore.getState().addNode('textGeneration');
    useFlowStore.getState().updateNode(id,{status:'fresh',value:'Neu',history,persisted:true});
    expect(await useFlowStore.getState().deleteHistoryResult(id,'new')).toBe(false);
    expect(await useFlowStore.getState().deleteHistoryResult(id,'old')).toBe(true);
    expect(useFlowStore.getState().nodes.find(node=>node.id===id)?.data.history?.map(item=>item.id)).toEqual(['new']);
  });
});
