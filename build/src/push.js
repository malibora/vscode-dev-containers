/*--------------------------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://go.microsoft.com/fwlink/?linkid=2090316 for license information.
 *-------------------------------------------------------------------------------------------------------------*/

const os = require('os');
const path = require('path');
const jsonc = require('jsonc').jsonc;
const asyncUtils = require('./utils/async');
const configUtils = require('./utils/config');
const prep = require('./prep');

async function push(repo, release, updateLatest, registry, registryPath, stubRegistry, stubRegistryPath, simulate, definitionId) {
    stubRegistry = stubRegistry || registry;
    stubRegistryPath = stubRegistryPath || registryPath;

    // Load config files
    await configUtils.loadConfig();

    const version = configUtils.getVersionFromRelease(release);
    const stagingFolder = path.join(os.tmpdir(), 'vscode-dev-containers', version);
    console.log(`(*) Copying files to ${stagingFolder}\n`);
    await asyncUtils.rimraf(stagingFolder); // Clean out folder if it exists
    await asyncUtils.mkdirp(stagingFolder); // Create the folder
    await asyncUtils.copyFiles(
        path.resolve(__dirname, '..', '..'),
        configUtils.getConfig('filesToStage'),
        stagingFolder);

    const definitionStagingFolder = path.join(stagingFolder, 'containers');

    // Build and push subset of images
    const definitionsToPush = definitionId ? [definitionId] : configUtils.getSortedDefinitionBuildList();
    for (let i = 0; i < definitionsToPush.length; i++) {
        const currentDefinitionId = definitionsToPush[i];
        console.log(`**** Pushing ${currentDefinitionId} ${release} ****`);
        await pushImage(path.join(definitionStagingFolder, currentDefinitionId),
            currentDefinitionId, repo, release, updateLatest, registry, registryPath, stubRegistry, stubRegistryPath, simulate);
    }

    // Update all definition config files for release (devcontainer.json, Dockerfile)
    const allDefinitions = definitionId ? [definitionId] : await asyncUtils.readdir(definitionStagingFolder);
    for (let i = 0; i < allDefinitions.length; i++) {
        const currentDefinitionId = allDefinitions[i];
        await prep.updateConfigForRelease(
            path.join(definitionStagingFolder, currentDefinitionId),
            currentDefinitionId, repo, release, registry, registryPath, stubRegistry, stubRegistryPath);
    }

    console.log('(*) Done!\n');

    return stagingFolder;
}

async function pushImage(definitionPath, definitionId, repo, release, updateLatest, registry, registryPath, stubRegistry, stubRegistryPath, simulate) {
    const dotDevContainerPath = path.join(definitionPath, '.devcontainer');
    // Use base.Dockerfile for image build if found, otherwise use Dockerfile
    const baseDockerFileExists = await asyncUtils.exists(path.join(dotDevContainerPath, 'base.Dockerfile'));
    const dockerFilePath = path.join(dotDevContainerPath, `${baseDockerFileExists ? 'base.' : ''}Dockerfile`);

    // Make sure there's a Dockerfile present
    if (!await asyncUtils.exists(dockerFilePath)) {
        throw `Invalid path ${dockerFilePath}`;
    }

    // Determine tags to use
    const versionTags = configUtils.getTagList(definitionId, release, updateLatest, registry, registryPath)
    console.log(`(*) Tags:${versionTags.reduce((prev, current) => prev += `\n     ${current}`, '')}`);

    // Look for context in devcontainer.json and use it to build the Dockerfile
    console.log('(*) Reading devcontainer.json...');
    const devContainerJsonPath = path.join(dotDevContainerPath, 'devcontainer.json');
    const devContainerJsonRaw = await asyncUtils.readFile(devContainerJsonPath);
    const devContainerJson = jsonc.parse(devContainerJsonRaw);

    // Update common setup script download URL, SHA
    console.log(`(*) Prep Dockerfile for ${definitionId}...`);
    await prep.prepDockerFile(dockerFilePath,
        definitionId, repo, release, registry, registryPath, stubRegistry, stubRegistryPath, true);

    // Build image
    console.log(`(*) Building image...`);
    const workingDir = path.resolve(dotDevContainerPath, devContainerJson.context || '.')
    const buildParams = versionTags.reduce((prev, current) => prev.concat(['-t', current]), []);
    const spawnOpts = { stdio: 'inherit', cwd: workingDir, shell: true };
    await asyncUtils.spawn('docker', ['build', workingDir, '-f', dockerFilePath].concat(buildParams), spawnOpts);

    // Push
    if (simulate) {
        console.log(`(*) Simulating: Skipping push to registry.`);
    } else {
        console.log(`(*) Pushing ${definitionId}...`);
        for (let i = 0; i < versionTags.length; i++) {
            await asyncUtils.spawn('docker', ['push', versionTags[i]], spawnOpts);
        }
    }

    // If base.Dockerfile found, update stub/devcontainer.json, otherwise create
    if (baseDockerFileExists) {
        await prep.updateStub(
            dotDevContainerPath, definitionId, repo, release, baseDockerFileExists, stubRegistry, stubRegistryPath);
        console.log('(*) Updating devcontainer.json...');
        await asyncUtils.writeFile(devContainerJsonPath, devContainerJsonRaw.replace('"base.Dockerfile"', '"Dockerfile"'));
        console.log('(*) Removing base.Dockerfile...');
        await asyncUtils.rimraf(dockerFilePath);
    } else {
        await prep.createStub(
            dotDevContainerPath, definitionId, repo, release, baseDockerFileExists, stubRegistry, stubRegistryPath);
    }

    console.log('(*) Done!\n');
}

module.exports = {
    push: push
}