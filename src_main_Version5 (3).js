// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import fetch from 'node-fetch';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = [{ url: 'https://github.com/facebook/react' }],
    maxFilesToProcess = 100,
    fileExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs'],
    excludePatterns = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next'],
    includeDocumentation = true,
    includeTests = false,
    generateCodeTree = true,
    extractSummaries = true,
    includeStatistics = true,
    maxFileSizeKB = 100,
    compressOutput = true,
    outputFormat = 'markdown',
} = (await Actor.getInput()) ?? {};

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    repositoriesProcessed: 0,
    filesProcessed: 0,
    totalLinesOfCode: 0,
    totalCharacters: 0,
    errors: 0,
    startTime: new Date(),
};

// Helper function to extract repo info from GitHub URL
function parseGitHubUrl(url) {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    return {
        owner: match[1],
        repo: match[2],
        url: url.replace(/\/$/, ''),
        apiUrl: `https://api.github.com/repos/${match[1]}/${match[2]}`,
        rawUrl: `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main`,
    };
}

// Helper function to check if file should be included
function shouldIncludeFile(path) {
    // Check if excluded
    for (const pattern of excludePatterns) {
        if (path.includes(pattern)) return false;
    }

    // Check if test file and should exclude
    if (!includeTests && (path.includes('test') || path.includes('spec') || path.includes('.test.'))) {
        return false;
    }

    // Check file extension
    const ext = path.substring(path.lastIndexOf('.'));
    if (fileExtensions.length > 0 && !fileExtensions.includes(ext)) {
        // Allow markdown and docs
        if (includeDocumentation && (ext === '.md' || ext === '.txt' || ext === '.rst')) {
            return true;
        }
        return false;
    }

    return true;
}

// Helper function to get language from file extension
function detectLanguage(filename) {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    const languageMap = {
        '.js': 'JavaScript',
        '.jsx': 'JavaScript',
        '.ts': 'TypeScript',
        '.tsx': 'TypeScript',
        '.py': 'Python',
        '.java': 'Java',
        '.go': 'Go',
        '.rs': 'Rust',
        '.cpp': 'C++',
        '.c': 'C',
        '.cs': 'C#',
        '.rb': 'Ruby',
        '.php': 'PHP',
        '.swift': 'Swift',
        '.kt': 'Kotlin',
        '.md': 'Markdown',
    };
    return languageMap[ext] || 'Other';
}

// Helper function to calculate code complexity (simple heuristic)
function calculateComplexity(code) {
    const lines = code.split('\n').length;
    const functions = (code.match(/function|def|fn|func|\=\>|class\s/g) || []).length;
    const branches = (code.match(/if|else|switch|for|while|catch/g) || []).length;

    const cyclomaticComplexity = branches + 1;
    const avgComplexityPerFunction = functions > 0 ? (cyclomaticComplexity / functions).toFixed(2) : 0;

    return {
        linesOfCode: lines,
        functions,
        branches,
        cyclomaticComplexity,
        avgComplexityPerFunction,
    };
}

// Helper function to generate file summary
function generateFileSummary(filename, code) {
    if (!extractSummaries) return '';

    // Extract imports/dependencies
    const imports = (code.match(/^(import|require|from|include|using)\s+.*/gm) || []).slice(0, 3);

    // Extract function/class names
    const language = detectLanguage(filename);
    let definitions = [];

    if (language === 'JavaScript' || language === 'TypeScript') {
        definitions = (code.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|class\s+(\w+)/g) || []).slice(0, 3);
    } else if (language === 'Python') {
        definitions = (code.match(/^(?:def|class)\s+(\w+)/gm) || []).slice(0, 3);
    } else if (language === 'Java') {
        definitions = (code.match(/(?:public|private)\s+(?:class|interface)\s+(\w+)/g) || []).slice(0, 3);
    }

    return {
        language,
        imports: imports.slice(0, 2),
        definitions: definitions.slice(0, 3),
        codeLength: code.length,
    };
}

// Helper function to create directory tree
function buildDirectoryTree(files) {
    const tree = {};

    files.forEach((file) => {
        const parts = file.path.split('/');
        let current = tree;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                // File
                if (!current.files) current.files = [];
                current.files.push({
                    name: part,
                    size: file.size,
                    language: detectLanguage(part),
                });
            } else {
                // Directory
                if (!current[part]) {
                    current[part] = {};
                }
                current = current[part];
            }
        }
    });

    return tree;
}

// Helper function to format tree as string
function formatTreeAsString(tree, indent = '') {
    let result = '';

    Object.entries(tree).forEach(([key, value]) => {
        if (key === 'files') {
            value.forEach((file) => {
                result += `${indent}├── ${file.name} (${file.language})\n`;
            });
        } else if (typeof value === 'object') {
            result += `${indent}├── ${key}/\n`;
            result += formatTreeAsString(value, indent + '│   ');
        }
    });

    return result;
}

// Helper function to fetch repository files
async function fetchRepositoryFiles(repoUrl, log) {
    const repoInfo = parseGitHubUrl(repoUrl);
    if (!repoInfo) {
        log.error(`Invalid GitHub URL: ${repoUrl}`);
        return [];
    }

    try {
        // Get repository structure from GitHub API
        const apiResponse = await fetch(`${repoInfo.apiUrl}/contents/`, {
            headers: {
                Accept: 'application/vnd.github.v3+json',
            },
        });

        if (!apiResponse.ok) {
            log.warning(`Could not fetch repo info: ${apiResponse.status}`);
            return [];
        }

        const contents = await apiResponse.json();
        const files = [];

        // Recursive function to get all files
        async function getAllFiles(items, basePath = '') {
            for (const item of items) {
                if (files.length >= maxFilesToProcess) break;

                const fullPath = basePath ? `${basePath}/${item.name}` : item.name;

                // Skip if excluded
                if (!shouldIncludeFile(fullPath)) continue;

                if (item.type === 'file') {
                    files.push({
                        path: fullPath,
                        url: item.download_url,
                        size: item.size,
                        sha: item.sha,
                    });
                } else if (item.type === 'dir') {
                    // Fetch directory contents
                    try {
                        const dirResponse = await fetch(`${repoInfo.apiUrl}/contents/${fullPath}`, {
                            headers: {
                                Accept: 'application/vnd.github.v3+json',
                            },
                        });

                        if (dirResponse.ok) {
                            const dirContents = await dirResponse.json();
                            await getAllFiles(dirContents, fullPath);
                        }
                    } catch (error) {
                        log.warning(`Could not fetch directory ${fullPath}: ${error.message}`);
                    }
                }
            }
        }

        await getAllFiles(contents);

        return {
            files,
            repoInfo,
        };
    } catch (error) {
        log.error(`Error fetching repository files: ${error.message}`);
        statistics.errors++;
        return [];
    }
}

// Helper function to fetch file content
async function fetchFileContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;

        const text = await response.text();
        return text;
    } catch (error) {
        return null;
    }
}

// Helper function to generate digest
async function generateDigest(repoUrl, filesList, log) {
    const repoInfo = parseGitHubUrl(repoUrl);
    const digest = {
        repository: repoInfo.url,
        owner: repoInfo.owner,
        name: repoInfo.repo,
        generatedAt: new Date().toISOString(),
        files: [],
        statistics: {},
        tree: null,
    };

    let totalLines = 0;
    let totalChars = 0;
    const languageStats = {};
    const filesByLanguage = {};

    // Process files
    log.info(`Processing ${filesList.files.length} files...`);

    for (let i = 0; i < Math.min(filesList.files.length, maxFilesToProcess); i++) {
        const file = filesList.files[i];

        // Skip if too large
        if (file.size > maxFileSizeKB * 1024) {
            log.debug(`Skipping ${file.path} (too large: ${file.size} bytes)`);
            continue;
        }

        // Fetch file content
        const content = await fetchFileContent(file.url);
        if (!content) continue;

        const language = detectLanguage(file.path);
        const lines = content.split('\n').length;
        const complexity = calculateComplexity(content);
        const summary = generateFileSummary(file.path, content);

        // Prepare file entry
        const fileEntry = {
            path: file.path,
            language,
            size: file.size,
            lines,
            url: file.url,
            complexity,
        };

        if (extractSummaries) {
            fileEntry.summary = summary;
        }

        // First 50 chars of code
        fileEntry.preview = content.substring(0, 100).replace(/\n/g, ' ');

        digest.files.push(fileEntry);

        // Update stats
        totalLines += lines;
        totalChars += content.length;
        languageStats[language] = (languageStats[language] || 0) + 1;
        if (!filesByLanguage[language]) filesByLanguage[language] = [];
        filesByLanguage[language].push(file.path);

        statistics.filesProcessed++;
        statistics.totalLinesOfCode += lines;
        statistics.totalCharacters += totalChars;

        // Log progress
        if ((i + 1) % 10 === 0) {
            log.info(`Processed ${i + 1} files...`);
        }
    }

    // Add statistics
    if (includeStatistics) {
        digest.statistics = {
            filesProcessed: digest.files.length,
            totalLines,
            totalCharacters: totalChars,
            languageBreakdown: languageStats,
            averageLinesPerFile: digest.files.length > 0 ? (totalLines / digest.files.length).toFixed(2) : 0,
            mainLanguage: Object.entries(languageStats).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown',
        };
    }

    // Add tree structure
    if (generateCodeTree) {
        const tree = buildDirectoryTree(digest.files);
        digest.tree = formatTreeAsString(tree);
    }

    return digest;
}

// Helper function to format digest as markdown
function formatDigestMarkdown(digest) {
    let markdown = '';

    markdown += `# ${digest.owner}/${digest.name} Codebase Digest\n\n`;
    markdown += `**Generated:** ${digest.generatedAt}\n\n`;

    // Statistics section
    if (digest.statistics) {
        markdown += `## 📊 Statistics\n\n`;
        markdown += `- **Files Processed:** ${digest.statistics.filesProcessed}\n`;
        markdown += `- **Total Lines:** ${digest.statistics.totalLines}\n`;
        markdown += `- **Main Language:** ${digest.statistics.mainLanguage}\n`;
        markdown += `- **Average Lines/File:** ${digest.statistics.averageLinesPerFile}\n\n`;

        markdown += `### Language Breakdown\n\n`;
        Object.entries(digest.statistics.languageBreakdown).forEach(([lang, count]) => {
            markdown += `- ${lang}: ${count} files\n`;
        });
        markdown += '\n';
    }

    // Directory tree
    if (digest.tree) {
        markdown += `## 📁 Directory Structure\n\n`;
        markdown += '```\n';
        markdown += digest.tree;
        markdown += '```\n\n';
    }

    // Files section
    markdown += `## 📄 Files\n\n`;

    digest.files.forEach((file, idx) => {
        markdown += `### ${idx + 1}. ${file.path}\n\n`;
        markdown += `- **Language:** ${file.language}\n`;
        markdown += `- **Lines:** ${file.lines}\n`;
        markdown += `- **Size:** ${file.size} bytes\n`;

        if (file.complexity) {
            markdown += `- **Complexity:** ${file.complexity.cyclomaticComplexity}\n`;
        }

        if (file.summary) {
            markdown += `- **Imports:** ${file.summary.imports.slice(0, 2).join(', ')}\n`;
        }

        markdown += '\n';
    });

    return markdown;
}

// Helper function to format digest as JSON
function formatDigestJSON(digest) {
    return JSON.stringify(digest, null, 2);
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 1,
    async requestHandler({ request, log }) {
        const repoUrl = request.loadedUrl;
        log.info(`Processing repository: ${repoUrl}`);

        try {
            // Fetch repository files
            const filesList = await fetchRepositoryFiles(repoUrl, log);

            if (!filesList.files || filesList.files.length === 0) {
                log.warning(`No files found in repository`);
                return;
            }

            // Generate digest
            const digest = await generateDigest(repoUrl, filesList, log);

            // Format digest
            let formattedDigest = '';
            if (outputFormat === 'json') {
                formattedDigest = formatDigestJSON(digest);
            } else {
                formattedDigest = formatDigestMarkdown(digest);
            }

            // Save to dataset
            await Dataset.pushData({
                repository: digest.repository,
                owner: digest.owner,
                name: digest.name,
                filesCount: digest.files.length,
                totalLines: digest.statistics.totalLines || 0,
                mainLanguage: digest.statistics.mainLanguage || 'Unknown',
                complexity: `${digest.files.length} files analyzed`,
                digestSize: (formattedDigest.length / 1024).toFixed(2),
                url: digest.repository,
            });

            // Save complete digest to KV store
            const kvStore = await KeyValueStore.open();
            const key = `REPO_DIGEST_${digest.owner}_${digest.name}`;
            await kvStore.setValue(key, formattedDigest);

            // Save code tree if available
            if (digest.tree) {
                await kvStore.setValue(`TREE_${digest.owner}_${digest.name}`, digest.tree);
            }

            statistics.repositoriesProcessed++;
            log.info(`Saved digest for ${digest.owner}/${digest.name}`);
        } catch (error) {
            log.error(`Error processing repository: ${error.message}`);
            statistics.errors++;
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(startUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Save statistics and report to Key-Value Store
const kvStore = await KeyValueStore.open();

const analysisReport = {
    reportDate: new Date().toISOString(),
    summary: {
        repositoriesProcessed: statistics.repositoriesProcessed,
        filesProcessed: statistics.filesProcessed,
        totalLinesOfCode: statistics.totalLinesOfCode,
        totalCharacters: statistics.totalCharacters,
        averageLinesPerFile:
            statistics.filesProcessed > 0 ? (statistics.totalLinesOfCode / statistics.filesProcessed).toFixed(2) : 0,
    },
    configuration: {
        maxFilesToProcess,
        fileExtensions,
        excludePatterns,
        includeDocumentation,
        includeTests,
        outputFormat,
    },
    errors: statistics.errors,
    duration: new Date() - statistics.startTime,
};

await kvStore.setValue('ANALYSIS_REPORT', JSON.stringify(analysisReport, null, 2));

console.log('\n=== GitHub Repo Digest Generation Complete ===');
console.log(`Repositories processed: ${statistics.repositoriesProcessed}`);
console.log(`Files processed: ${statistics.filesProcessed}`);
console.log(`Total lines of code: ${statistics.totalLinesOfCode}`);
console.log(`Average lines per file: ${(statistics.totalLinesOfCode / (statistics.filesProcessed || 1)).toFixed(2)}`);
console.log(`Errors: ${statistics.errors}`);

// Gracefully exit the Actor process
await Actor.exit();