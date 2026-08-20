import { CodeEditor, DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import type { Language } from '@patternfly/react-code-editor';
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateBody,
  PageSection,
  Sidebar,
  SidebarContent,
  SidebarPanel,
} from '@patternfly/react-core';
import { CodeIcon } from '@patternfly/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { EditToolbar } from './components/EditToolbar';
import { FileTreeView } from './components/FileTreeView';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthProvider } from '../../common/context/AuthProvider';
import { getFiles, listFunctions, putFiles } from '../../common/clients/functionsClient';
import { FileEntry, FunctionListItem } from '../../common/types';
import { getLanguageFromPath, handlerMap } from '../../common/utils/utils';

// --- page component ---

export default function FunctionEditPage() {
  return (
    <AuthProvider>
      <FunctionEditPageContent />
    </AuthProvider>
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
        <Sidebar hasGutter hasBorder>
          <SidebarPanel width={{ default: 'width_25' }}>
            {state.repoInfo && (
              <DescriptionList isHorizontal isCompact>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Repository')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <a href={state.repoInfo.repoURL} target="_blank" rel="noopener noreferrer">
                      {state.repoInfo.owner}/{state.repoInfo.repoName}
                    </a>
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Branch')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {state.repoInfo.defaultBranch}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              </DescriptionList>
            )}
            <FileTreeView
              files={state.files}
              selectedPath={state.selectedPath}
              dirtyPaths={state.dirtyPaths}
              isLoading={state.isLoading}
              onSelect={state.onFileSelect}
              onDelete={state.onFileDelete}
            />
          </SidebarPanel>
          <SidebarContent>
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
              editorProps={{
                beforeMount: (monaco) => {
                  // SRVOCF-1007: the OCP console does not bundle Monaco's TS worker.
                  // Disable all worker-dependent features for JS/TS so the missing
                  // worker is never requested. Monarch syntax highlighting is unaffected.
                  monaco.languages.typescript.javascriptDefaults.setModeConfiguration({});
                  monaco.languages.typescript.typescriptDefaults.setModeConfiguration({});
                },
              }}
            />
          </SidebarContent>
        </Sidebar>
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
  repoInfo: FunctionListItem | undefined;
  onFileSelect: (path: string) => void;
  onFileChange: (content: string) => void;
  onFileDelete: (path: string) => void;
  saveFiles: () => Promise<void>;
}

function useFunctionEditPage(): FunctionEditPageState {
  const { name: repoName } = useParams<{ name: string }>();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [originalFiles, setOriginalFiles] = useState<FileEntry[]>([]);
  const [repoInfo, setRepoInfo] = useState<FunctionListItem>();
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  const originalByPath = useMemo(
    () => new Map(originalFiles.map((f) => [f.path, f])),
    [originalFiles],
  );
  const currentPaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const deletedFiles = useMemo(
    () =>
      originalFiles
        .filter((f) => !currentPaths.has(f.path))
        .map((f) => ({ ...f, deleted: true as const })),
    [originalFiles, currentPaths],
  );
  const dirtyFiles = useMemo(
    () =>
      new Set(
        files
          .filter((f) => {
            const orig = originalByPath.get(f.path);
            return orig && f.content !== orig.content;
          })
          .map((f) => f.path),
      ),
    [files, originalByPath],
  );
  const hasChanges = dirtyFiles.size > 0 || deletedFiles.length > 0;

  const selectedFile = files.find((f) => f.path === selectedPath);
  const selectedContent = selectedFile?.content ?? '';
  const selectedLanguage = getLanguageFromPath(selectedPath);

  useEffect(() => {
    let ignore = false;

    async function loadFiles() {
      let repo: { content: FileEntry[]; info: FunctionListItem };
      try {
        repo = await resolveRepoContent(repoName!);
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
      setOriginalFiles(repo.content.map((f) => ({ ...f })));
      setRepoInfo(repo.info);
      setSelectedPath(determineHandler(repo.content, repo.info.runtime));
      setIsLoading(false);
    }

    loadFiles();
    return () => {
      ignore = true;
    };
  }, [repoName]);

  const onFileSelect = (path: string) => {
    setSelectedPath(path);
  };

  const onFileChange = (content: string) => {
    if (!selectedPath) return;
    setFiles((prev) => prev.map((f) => (f.path === selectedPath ? { ...f, content } : f)));
  };

  const onFileDelete = useCallback(
    (path: string) => {
      const dirPrefix = path + '/';
      const pathsToDelete = new Set(
        files.filter((f) => f.path === path || f.path.startsWith(dirPrefix)).map((f) => f.path),
      );
      if (pathsToDelete.size === 0) return;
      setFiles((prev) => prev.filter((f) => !pathsToDelete.has(f.path)));
      if (selectedPath && pathsToDelete.has(selectedPath)) setSelectedPath('');
    },
    [files, selectedPath],
  );

  const saveFiles = async () => {
    if (!repoInfo) return;
    await putFiles(
      repoInfo.owner,
      repoInfo.repoName,
      [...files, ...deletedFiles],
      'Update function files',
      repoInfo.defaultBranch,
    );
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
    repoInfo,
    onFileSelect,
    onFileChange,
    onFileDelete,
    saveFiles,
  };
}

async function resolveRepoContent(
  repoName: string,
): Promise<{ content: FileEntry[]; info: FunctionListItem }> {
  const items = await listFunctions();
  const item = items.find((r) => r.repoName === repoName);
  if (!item) throw new Error(`repository ${repoName} not found`);

  return {
    content: await getFiles(item.owner, item.repoName),
    info: item,
  };
}

function determineHandler(loadedFiles: FileEntry[], runtime: string): string {
  const handlerPath = handlerMap[runtime];
  if (handlerPath && loadedFiles.find((f) => f.path === handlerPath)) return handlerPath;
  return '';
}
