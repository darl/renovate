/* eslint no-plusplus: 0  */
import parse from 'github-url-from-git';
import { parse as _parse } from 'url';
import { logger } from '../../logger';
import { PackageDependency, PackageFile } from '../common';
import { regEx } from '../../util/regex';
import * as dockerVersioning from '../../versioning/docker';
import * as mavenVersioning from '../../versioning/maven';
import {
  DATASOURCE_DOCKER,
  DATASOURCE_GITHUB,
  DATASOURCE_GO,
  DATASOURCE_MAVEN,
} from '../../constants/data-binary-source';
import { DEFAULT_MAVEN_REPO } from '../maven/extract';

interface UrlParsedResult {
  repo: string;
  currentValue: string;
}

function parseUrl(urlString: string): UrlParsedResult | null {
  // istanbul ignore if
  if (!urlString) {
    return null;
  }
  const url = _parse(urlString);
  if (url.host !== 'github.com') {
    return null;
  }
  const path = url.path.split('/').slice(1);
  const repo = path[0] + '/' + path[1];
  let currentValue: string = null;
  if (path[2] === 'releases' && path[3] === 'download') {
    currentValue = path[4];
  }
  if (path[2] === 'archive') {
    currentValue = path[3].replace(/\.tar\.gz$/, '');
  }
  if (currentValue) {
    return { repo, currentValue };
  }
  // istanbul ignore next
  return null;
}

function findBalancedParenIndex(
  longString: string,
  open = '(',
  close = ')'
): number {
  /**
   * Minimalistic string parser with single task -> find last char in def.
   * It treats [)] as the last char.
   * To find needed closing parenthesis we need to increment
   * nesting depth when parser feeds opening parenthesis
   * if one opening parenthesis -> 1
   * if two opening parenthesis -> 2
   * if two opening and one closing parenthesis -> 1
   * if ["""] finded then ignore all [)] until closing ["""] parsed.
   * https://github.com/renovatebot/renovate/pull/3459#issuecomment-478249702
   */
  let intShouldNotBeOdd = 0; // openClosePythonMultiLineComment
  let parenNestingDepth = 1;
  return [...longString].findIndex((char, i, arr) => {
    switch (char) {
      case open:
        parenNestingDepth++;
        break;
      case close:
        parenNestingDepth--;
        break;
      case '"':
        if (i > 1 && arr.slice(i - 2, i).every(prev => char === prev))
          intShouldNotBeOdd++;
        break;
      default:
        break;
    }

    return !parenNestingDepth && !(intShouldNotBeOdd % 2) && char === close;
  });
}

function parseArtifacts(
  content: string,
  startOffset: number
): PackageDependency[] {
  let idx = 0;
  const res: PackageDependency[] = [];

  while (idx < content.length) {
    if (content[idx] === ' ' || content[idx] === '\n') {
      idx++;
    } else {
      const rest = content.substring(idx);

      let groupId: string;
      let artifact: string;
      let version: string;
      let replaceData: string;
      let fileReplacePosition: number;

      const stringMatch = /"([^"]+)"\s*,/g.exec(rest);
      const callMatch = /maven\.artifact\s*\(/g.exec(rest);

      if (stringMatch && (!callMatch || stringMatch.index < callMatch.index)) {
        replaceData = stringMatch[0];
        const str = stringMatch[1];
        [groupId, artifact, version] = str.split(':');
        const ss = rest.slice(stringMatch.index);
        const positionOfSecondColon = ss.indexOf(':', ss.indexOf(':') + 1);
        fileReplacePosition =
          startOffset + idx + stringMatch.index + positionOfSecondColon + 1;
        idx = idx + stringMatch.index + stringMatch[0].length + 1;
      } else if (callMatch) {
        const matchEndPos = callMatch.index + callMatch[0].length;
        const callEndPos =
          matchEndPos + findBalancedParenIndex(rest.slice(matchEndPos));
        replaceData = rest.slice(callMatch.index, callEndPos + 1);

        let match = /group\s*=\s*"([^"]+)"/.exec(replaceData);
        if (match) {
          [, groupId] = match;
        }
        match = /artifact\s*=\s*"([^"]+)"/.exec(replaceData);
        if (match) {
          [, artifact] = match;
        }
        match = /version\s*=\s*"([^"]+)"/.exec(replaceData);
        if (match) {
          [, version] = match;
          const versionPosition = match[0].indexOf('"') + 1;
          fileReplacePosition =
            startOffset + idx + matchEndPos + versionPosition;
        }
        idx = idx + callEndPos + 1;
      } else {
        return res;
      }

      if (groupId && artifact && version && fileReplacePosition) {
        res.push({
          datasource: DATASOURCE_MAVEN,
          versioning: mavenVersioning.id,
          depName: `${groupId}:${artifact}`,
          currentValue: version,
          registryUrls: [DEFAULT_MAVEN_REPO],
          managerData: { replaceData },
        });
      }
    }
  }

  return res;
}

function parseRepositories(content: string): string[] {
  let idx = 0;
  const res: string[] = [];

  while (idx < content.length) {
    if (content[idx] === ' ' || content[idx] === '\n') {
      idx++;
    } else {
      const rest = content.substring(idx);

      const stringMatch = /"([^"]+)"\s*,/g.exec(rest);
      const callMatch = /maven\.repository\s*\(/g.exec(rest);

      if (stringMatch && (!callMatch || stringMatch.index < callMatch.index)) {
        const str = stringMatch[1];
        res.push(str);

        idx = idx + stringMatch.index + stringMatch[0].length + 1;
      } else if (callMatch) {
        const matchEndPos = callMatch.index + callMatch[0].length;
        const callEndPos =
          matchEndPos + findBalancedParenIndex(rest.slice(matchEndPos));
        const callStr = rest.slice(matchEndPos, callEndPos + 1);
        const match = /"([^"]+)"/.exec(callStr);
        if (match) {
          res.push(match[1]);
        }
        idx = idx + callEndPos + 1;
      } else {
        return res;
      }
    }
  }

  return res;
}

function parseContent(content: string): string[] {
  return [
    'container_pull',
    'http_archive',
    'go_repository',
    'git_repository',
    'maven_install',
  ].reduce(
    (acc, prefix) => [
      ...acc,
      ...content
        .split(regEx(prefix + '\\s*\\(', 'g'))
        .slice(1)
        .map(base => {
          const ind = findBalancedParenIndex(base);

          return ind >= 0 && `${prefix}(${base.slice(0, ind)})`;
        })
        .filter(Boolean),
    ],
    [] as string[]
  );
}

export function extractPackageFile(content: string): PackageFile | null {
  const definitions = parseContent(content);
  if (!definitions.length) {
    logger.debug('No matching WORKSPACE definitions found');
    return null;
  }
  logger.debug({ definitions }, `Found ${definitions.length} definitions`);
  const deps: PackageDependency[] = [];
  definitions.forEach(def => {
    logger.debug({ def }, 'Checking bazel definition');
    const [depType] = def.split('(', 1);
    const dep: PackageDependency = { depType, managerData: { def } };
    let depName: string;
    let importpath: string;
    let remote: string;
    let currentValue: string;
    let commit: string;
    let url: string;
    let sha256: string;
    let digest: string;
    let repository: string;
    let registry: string;
    let artifacts: PackageDependency[];
    let repositories: string[];
    let match = /name\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, depName] = match;
    }
    match = /digest\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, digest] = match;
    }
    match = /registry\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, registry] = match;
    }
    match = /repository\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, repository] = match;
    }
    match = /remote\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, remote] = match;
    }
    match = /tag\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, currentValue] = match;
    }
    match = /url\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, url] = match;
    }
    match = /urls\s*=\s*\[\s*"([^\]]+)",?\s*\]/.exec(def);
    if (match) {
      const urls = match[1].replace(/\s/g, '').split('","');
      url = urls.find(parseUrl);
    }
    match = /commit\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, commit] = match;
    }
    match = /sha256\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, sha256] = match;
    }
    match = /importpath\s*=\s*"([^"]+)"/.exec(def);
    if (match) {
      [, importpath] = match;
    }
    match = /artifacts\s*=\s*\[/.exec(def);
    if (match) {
      const matchEnd = match.index + match[0].length;
      const end = findBalancedParenIndex(def.slice(matchEnd), '[', ']');
      artifacts = parseArtifacts(def.slice(matchEnd, matchEnd + end), matchEnd);
    }
    match = /repositories\s*=\s*\[/.exec(def);
    if (match) {
      const matchEnd = match.index + match[0].length;
      const end = findBalancedParenIndex(def.slice(matchEnd), '[', ']');
      repositories = parseRepositories(def.slice(matchEnd, matchEnd + end));
    }
    logger.debug({ dependency: depName, remote, currentValue });
    if (
      depType === 'git_repository' &&
      depName &&
      remote &&
      (currentValue || commit)
    ) {
      dep.depName = depName;
      if (currentValue) {
        dep.currentValue = currentValue;
      }
      if (commit) {
        dep.currentDigest = commit;
      }
      // TODO: Check if we really need to use parse here or if it should always be a plain https url
      const githubURL = parse(remote);
      if (githubURL) {
        const repo = githubURL.substring('https://github.com/'.length);
        dep.datasource = DATASOURCE_GITHUB;
        dep.lookupName = repo;
        deps.push(dep);
      }
    } else if (
      depType === 'go_repository' &&
      depName &&
      importpath &&
      (currentValue || commit)
    ) {
      dep.depName = depName;
      dep.currentValue = currentValue || commit.substr(0, 7);
      dep.datasource = DATASOURCE_GO;
      dep.lookupName = importpath;
      if (remote) {
        const remoteMatch = /https:\/\/github\.com(?:.*\/)(([a-zA-Z]+)([-])?([a-zA-Z]+))/.exec(
          remote
        );
        if (remoteMatch && remoteMatch[0].length === remote.length) {
          dep.lookupName = remote.replace('https://', '');
        } else {
          dep.skipReason = 'unsupported-remote';
        }
      }
      if (commit) {
        dep.currentValue = 'v0.0.0';
        dep.currentDigest = commit;
        dep.currentDigestShort = commit.substr(0, 7);
        dep.digestOneAndOnly = true;
      }
      deps.push(dep);
    } else if (
      depType === 'http_archive' &&
      depName &&
      parseUrl(url) &&
      sha256
    ) {
      const parsedUrl = parseUrl(url);
      dep.depName = depName;
      dep.repo = parsedUrl.repo;
      if (/^[a-f0-9]{40}$/i.test(parsedUrl.currentValue)) {
        dep.currentDigest = parsedUrl.currentValue;
      } else {
        dep.currentValue = parsedUrl.currentValue;
      }
      dep.datasource = DATASOURCE_GITHUB;
      dep.lookupName = dep.repo;
      dep.lookupType = 'releases';
      deps.push(dep);
    } else if (
      depType === 'container_pull' &&
      currentValue &&
      digest &&
      repository &&
      registry
    ) {
      dep.currentDigest = digest;
      dep.currentValue = currentValue;
      dep.depName = depName;
      dep.versioning = dockerVersioning.id;
      dep.datasource = DATASOURCE_DOCKER;
      dep.lookupName = repository;
      deps.push(dep);
    } else if (depType === 'maven_install' && artifacts) {
      const ruleName = depName;
      artifacts.forEach(artifact => {
        const mavenDep: PackageDependency = {
          depType,
          ...artifact,
          managerData: { ruleName, ...artifact.managerData },
        };
        if (repositories) {
          Array.prototype.push.apply(mavenDep.registryUrls, repositories);
        }
        logger.debug({ artDep: mavenDep }, 'Found maven dependency');
        deps.push(mavenDep);
      });
    } else {
      logger.info(
        { def },
        'Failed to find dependency in bazel WORKSPACE definition'
      );
    }
  });
  if (!deps.length) {
    return null;
  }
  return { deps };
}
