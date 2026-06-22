import { CodeEditor, DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import type { Language } from '@patternfly/react-code-editor';
import { EmptyState, EmptyStateBody, Flex, FlexItem, PageSection } from '@patternfly/react-core';
import { CodeIcon } from '@patternfly/react-icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom-v5-compat';
import { EditToolbar } from './components/EditToolbar';
import { FileTreeView } from './components/FileTreeView';
import { UserAvatar } from '../../common/components/UserAvatar';
import { ForgeConnectionProvider } from '../../common/context/ForgeConnectionProvider';
import { SourceControlService } from '../../common/services/source-control/SourceControlService';
import { useSourceControlService } from '../../common/services/source-control/useSourceControlService';
import { FileEntry, RepoMetadata } from '../../common/services/types';
import { getLanguageFromPath, handlerMap, parseFuncYaml } from '../../common/utils/utils';

// --- page component ---

export default function FunctionEditPage() {
  return (
    <ForgeConnectionProvider>
      <FunctionEditPageContent />
    </ForgeConnectionProvider>
  );
}

function FunctionEditPageContent() {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const state = useFunctionEditPage();

  return (
    <>
      <DocumentTitle>{t('Edit function')}</DocumentTitle>
      <ListPageHeader title={`${t('Edit function')}`}>
        <UserAvatar enableReconnect={false} />
      </ListPageHeader>
      <PageSection>
        <EditToolbar hasChanges={state.hasChanges} onSave={state.saveFiles} />
        <Flex
          direction={{ default: 'row' }}
          flexWrap={{ default: 'nowrap' }}
          alignItems={{ default: 'alignItemsStretch' }}
        >
          <FlexItem
            flex={{ default: 'flexNone' }}
            style={{ width: '16rem', overflowX: 'auto', overflowY: 'auto' }}
          >
            <FileTreeView
              files={state.files}
              selectedPath={state.selectedPath}
              dirtyPaths={state.dirtyPaths}
              isLoading={state.isLoading}
              onSelect={state.onFileSelect}
            />
          </FlexItem>
          <FlexItem grow={{ default: 'grow' }} style={{ minWidth: '32rem' }}>
            <CodeEditor
              value={state.selectedContent}
              language={state.selectedLanguage}
              onChange={state.onFileChange}
              height="70vh"
              showEditor={!!state.selectedPath}
              emptyState={
                <EmptyState icon={CodeIcon} titleText={t('Start editing')} variant="lg">
                  <EmptyStateBody>
                    {t('Select a file from the tree view to start editing.')}
                  </EmptyStateBody>
                </EmptyState>
              }
              isLanguageLabelVisible
            />
          </FlexItem>
        </Flex>
      </PageSection>
    </>
  );
}

// --- page hook ---

interface FunctionEditPageState {
  files: FileEntry[];
  selectedPath: string | null;
  selectedContent: string;
  selectedLanguage: Language;
  dirtyPaths: Set<string>;
  hasChanges: boolean;
  isLoading: boolean;
  repoMetadata: RepoMetadata | undefined;
  onFileSelect: (path: string) => void;
  onFileChange: (content: string) => void;
  saveFiles: () => Promise<void>;
}

function useFunctionEditPage(): FunctionEditPageState {
  const sourceControl = useSourceControlService();
  const { name: repoName } = useParams<{ name: string }>();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [originalFiles, setOriginalFiles] = useState<FileEntry[]>([]);
  const [repoMetadata, setRepoMetadata] = useState<RepoMetadata>();
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  const dirtyFiles = new Set(
    files
      // Guard: originalFiles is empty during initial render before fetch completes.
      .filter((f, i) => originalFiles[i] && f.content !== originalFiles[i].content)
      .map((f) => f.path),
  );
  const hasChanges = dirtyFiles.size > 0;

  const selectedFile = files.find((f) => f.path === selectedPath);
  const selectedContent = selectedFile?.content ?? '';
  const selectedLanguage = getLanguageFromPath(selectedPath);

  useEffect(() => {
    let ignore = false;

    async function loadFiles() {
      let repo: { content: FileEntry[]; metadata: RepoMetadata };
      try {
        // we ignore the error and show an empty tree if repo is not found
        repo = await resolveRepoContent(repoName!, sourceControl);
      } catch {
        if (!ignore) setIsLoading(false);
        return;
      }
      if (ignore) return;

      if (repo.content.length === 0) {
        setIsLoading(false);
        return;
      }

      setFiles(repo.content);
      // Shallow copy each entry so files and originalFiles hold
      // different object references. When onFileChange updates a
      // file's content via setFiles, the corresponding originalFiles
      // entry stays unchanged, enabling dirty comparison.
      setOriginalFiles(repo.content.map((f) => ({ ...f })));
      setRepoMetadata(repo.metadata);
      setSelectedPath(determineHandler(repo.content));
      setIsLoading(false);
    }

    loadFiles();
    return () => {
      ignore = true;
    };
  }, [repoName, sourceControl]);

  const onFileSelect = (path: string) => {
    setSelectedPath(path);
  };

  const onFileChange = (content: string) => {
    if (!selectedPath) return;
    setFiles((prev) => prev.map((f) => (f.path === selectedPath ? { ...f, content } : f)));
  };

  const saveFiles = async () => {
    if (!repoMetadata) return;
    await sourceControl.updateRepo(repoMetadata, files, 'Update function files');
    setOriginalFiles(files.map((f) => ({ ...f })));
  };

  return {
    files,
    selectedPath,
    selectedContent,
    selectedLanguage,
    dirtyPaths: dirtyFiles,
    hasChanges,
    isLoading,
    repoMetadata,
    onFileSelect,
    onFileChange,
    saveFiles,
  };
}

async function resolveRepoContent(
  repoName: string,
  sourceControl: SourceControlService,
): Promise<{ content: FileEntry[]; metadata: RepoMetadata }> {
  const repos = await sourceControl.listFunctionRepos();

  const repoMetadata = repos.find((r) => r.name === repoName);
  if (!repoMetadata) throw new Error(`repository ${repoName} not found`);

  return {
    content: await sourceControl.fetch(repoMetadata),
    metadata: repoMetadata,
  };
}

function determineHandler(loadedFiles: FileEntry[]): string {
  const funcYaml = loadedFiles.find((f) => f.path === 'func.yaml');
  if (!funcYaml) return '';

  const { runtime } = parseFuncYaml(funcYaml.content);

  const handlerPath = handlerMap[runtime];
  if (loadedFiles.find((f) => f.path === handlerPath)) return handlerPath;
  return '';
}
