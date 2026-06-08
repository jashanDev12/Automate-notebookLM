import { useCallback, useState } from 'react';

interface Props {
  disabled?: boolean;
  onFileSelected: (file: File) => void;
}

export function FileDropZone({ disabled, onFileSelected }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files?.length || disabled) return;
      onFileSelected(files[0]);
    },
    [disabled, onFileSelected],
  );

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
        dragOver
          ? 'border-nlm-blue bg-blue-50'
          : 'border-nlm-border bg-white hover:border-gray-400'
      } ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.txt,.md,.markdown,.mp4,.webm,.mov,.mkv,video/*';
        input.onchange = () => handleFiles(input.files);
        input.click();
      }}
    >
      <div className="text-3xl mb-2">📄</div>
      <p className="font-medium text-gray-800">Drop a file here or click to browse</p>
      <p className="text-sm text-gray-500 mt-1">
        PDF, TXT, Markdown, or MP4/video (under 200MB)
      </p>
    </div>
  );
}
