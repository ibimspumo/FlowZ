import { invoke } from '@tauri-apps/api/core';
import { decodeProjectDocument, type ProjectDocument } from '../domain';

export type ProjectDiagnosis = 'healthy' | 'recovered' | 'corrupt' | 'unsupported';
export type ProjectSummary = {
  id: string;
  name?: string;
  updatedAt?: string;
  revision?: number;
  diagnosis: ProjectDiagnosis;
  message?: string;
};
export type OpenProject = { project: ProjectDocument; revision: number };
export type SaveProjectRequest = {
  project: ProjectDocument;
  expectedUpdatedAt: string;
  expectedRevision: number;
};

export class ProjectConflictError extends Error {
  constructor(message = 'Das Projekt wurde an anderer Stelle geändert.') {
    super(message);
    this.name = 'ProjectConflictError';
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalizeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /Speicherkonflikt/i.test(message) ? new ProjectConflictError(message) : new Error(message);
}

function decodeOpened(value: { project: unknown; revision: number }): OpenProject {
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Die Projektrevision ist ungültig oder zu groß für diese FlowZ-Version.');
  }
  return { project: decodeProjectDocument(value.project), revision: value.revision };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!isDesktopRuntime()) return [];
  try { return await invoke<ProjectSummary[]>('project_list'); }
  catch (error) { throw normalizeError(error); }
}

export async function createProject(name: string): Promise<OpenProject> {
  if (!isDesktopRuntime()) throw new Error('Projektdateien sind nur in der Desktop-App verfügbar.');
  try { return decodeOpened(await invoke('project_create', { request: { name } })); }
  catch (error) { throw normalizeError(error); }
}

export async function openProject(id: string): Promise<OpenProject> {
  if (!isDesktopRuntime()) throw new Error('Projektdateien sind nur in der Desktop-App verfügbar.');
  try { return decodeOpened(await invoke('project_open', { id })); }
  catch (error) { throw normalizeError(error); }
}

export async function saveProject(request: SaveProjectRequest): Promise<OpenProject> {
  if (!isDesktopRuntime()) throw new Error('Projektdateien sind nur in der Desktop-App verfügbar.');
  try { return decodeOpened(await invoke('project_save', { request })); }
  catch (error) { throw normalizeError(error); }
}
