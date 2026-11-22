import { useMemo, useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";
import { api } from "./api";
import { languageFor } from "./domain";

export interface EditorFile { path: string; content: string; baseExists: boolean; sessionId: string }

export default function EditorDialog({ file, onClose, onStaged }: { file: EditorFile; onClose: () => void; onStaged: (sessionId: string) => Promise<void> }) {
  const [path, setPath] = useState(file.path);
  const [content, setContent] = useState(file.content);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const extensions = useMemo(() => {
    switch (languageFor(path)) {
      case "rust": return [rust()];
      case "json": return [json()];
      case "typescript": return [javascript({ typescript: true, jsx: true })];
      default: return [];
    }
  }, [path]);
  const changed = content !== file.content || !file.baseExists;
  const stage = async () => {
    setSaving(true); setError("");
    try {
      await api.stageEdit({ sessionId: file.sessionId, path, content, baseContent: file.content, baseExists: file.baseExists });
      await onStaged(file.sessionId); onClose();
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  };
  return <Modal open title={file.baseExists ? `编辑 · ${file.path}` : "新建文件提案"} width={960} maskClosable={false} onCancel={() => {
    if (!changed || window.confirm("放弃尚未生成提案的编辑？")) onClose();
  }} footer={<Button type="primary" loading={saving} disabled={!path.trim() || !changed} onClick={() => void stage()}>生成审阅提案</Button>}>
    <Alert type="info" message="此处只编辑草稿。生成提案后仍需在对话中审阅并应用，才会写入项目。" />
    {!file.baseExists && <label className="editor-path">项目相对路径<Input aria-label="新文件路径" value={path} onChange={(event) => setPath(event.target.value)} placeholder="src/example.ts" /></label>}
    <div className="code-editor"><CodeMirror value={content} onChange={setContent} extensions={extensions} height="420px" theme="dark" basicSetup={{ lineNumbers: true, foldGutter: true }} /></div>
    {error && <Alert type="error" showIcon message={error} />}
  </Modal>;
}
