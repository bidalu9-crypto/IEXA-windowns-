"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGitRoute = handleGitRoute;
const HttpServer_1 = require("./HttpServer");
const GitService_1 = require("../git/GitService");
const gitService = new GitService_1.GitService();
async function handleGitRoute(req, res, url, ctx) {
    if (url.pathname === '/api/git/status' && req.method === 'GET') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        (0, HttpServer_1.jsonReply)(res, 200, await gitService.status(projectRoot));
        return true;
    }
    if (url.pathname === '/api/git/diff' && req.method === 'GET') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        try {
            const target = url.searchParams.get('path') || undefined;
            const staged = url.searchParams.get('staged') === '1';
            (0, HttpServer_1.jsonReply)(res, 200, await gitService.diff(projectRoot, target, staged));
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname === '/api/git/branches' && req.method === 'GET') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        try {
            (0, HttpServer_1.jsonReply)(res, 200, { branches: await gitService.branches(projectRoot) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (url.pathname === '/api/git/log' && req.method === 'GET') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        try {
            (0, HttpServer_1.jsonReply)(res, 200, { entries: await gitService.log(projectRoot, Number(url.searchParams.get('limit') || 12)) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if ((url.pathname === '/api/git/stage' || url.pathname === '/api/git/unstage' || url.pathname === '/api/git/restore') && req.method === 'POST') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            const paths = Array.isArray(body.paths) ? body.paths.filter((value) => typeof value === 'string') : [];
            if (url.pathname.endsWith('/stage'))
                await gitService.stage(projectRoot, paths);
            else if (url.pathname.endsWith('/unstage'))
                await gitService.unstage(projectRoot, paths);
            else
                await gitService.restore(projectRoot, paths);
            (0, HttpServer_1.jsonReply)(res, 200, await gitService.status(projectRoot));
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    if (['/api/git/stage-all', '/api/git/switch', '/api/git/create-branch', '/api/git/commit', '/api/git/pull', '/api/git/push'].includes(url.pathname) && req.method === 'POST') {
        const projectRoot = ctx.getProjectRoot();
        if (!projectRoot) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: '尚未打开项目' });
            return true;
        }
        try {
            const body = JSON.parse(await (0, HttpServer_1.readBody)(req) || '{}');
            if (url.pathname.endsWith('/stage-all'))
                await gitService.stageAll(projectRoot);
            if (url.pathname.endsWith('/switch'))
                await gitService.switchBranch(projectRoot, String(body.branch || ''));
            if (url.pathname.endsWith('/create-branch'))
                await gitService.createBranch(projectRoot, String(body.branch || ''));
            if (url.pathname.endsWith('/commit'))
                await gitService.commit(projectRoot, String(body.message || ''));
            if (url.pathname.endsWith('/pull'))
                await gitService.pull(projectRoot);
            if (url.pathname.endsWith('/push'))
                await gitService.push(projectRoot);
            (0, HttpServer_1.jsonReply)(res, 200, { status: await gitService.status(projectRoot) });
        }
        catch (error) {
            (0, HttpServer_1.jsonReply)(res, 400, { error: error.message });
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=GitRoutes.js.map