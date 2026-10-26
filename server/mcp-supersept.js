#!/usr/bin/env node
// MCP server (stdio) exposing the same actions as the `supersept` CLI. Some enterprise policies
// block local MCP servers; chat agents then use the CLI instead (see chat.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ops from './ops.js';

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const tool = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return { isError: true, content: [{ type: 'text', text: `Erreur : ${e.message}` }] }; } };
const server = new McpServer({ name: 'supersept', version: '1.0.0' });

server.tool('list_projects', 'Liste les projets et leurs sessions.', {}, tool(() => ops.listProjects()));
server.tool('create_project', 'Crée un projet (repo GitHub, dossier existant ou vide).', { name: z.string(), github: z.string().optional(), folder: z.string().optional() }, tool((a) => ops.createProject(a)));
server.tool('start_session', 'Lance une session Claude Code avec une mission.', { task: z.string(), project: z.string().optional(), name: z.string().optional(), mode: z.enum(['local', 'worktree']).optional(), agent: z.string().optional() }, tool((a) => ops.startSession(a)));
server.tool('list_sessions', 'Liste les sessions.', { project: z.string().optional(), mine: z.boolean().optional() }, tool((a) => ops.listSessions(a)));
server.tool('get_session', "Détail d'une session.", { id: z.string() }, tool(({ id }) => ops.getSession(id)));
server.tool('send_to_session', 'Envoie un message à une session.', { id: z.string(), message: z.string() }, tool(({ id, message }) => ops.sendToSession(id, message)));
server.tool('archive_session', 'Archive une session.', { id: z.string() }, tool(({ id }) => ops.archiveSession(id)));
server.tool('read_project_memory', "Lit la mémoire d'un projet.", { project: z.string() }, tool(({ project }) => ops.readMemory(project)));
server.tool('update_project_memory', "Remplace la mémoire d'un projet.", { project: z.string(), content: z.string() }, tool(({ project, content }) => ops.writeMemory(project, content)));

await server.connect(new StdioServerTransport());
