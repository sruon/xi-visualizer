import { createDropzone } from "@soorria/solid-dropzone";
import { createSignal, Show } from "solid-js";
import NavMeshViewer from "../components/navmesh_viewer";

export default function NavMeshPage() {
  const [navData, setNavData] = createSignal<ArrayBuffer | undefined>();
  const [fileName, setFileName] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();

  const loadFile = async (file: File) => {
    setError(undefined);
    try {
      const buffer = await file.arrayBuffer();
      setFileName(file.name);
      setNavData(buffer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDrop = (acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      loadFile(acceptedFiles[0]);
    }
  };
  const dropzone = createDropzone({ onDrop });

  const reset = () => {
    setNavData(undefined);
    setFileName("");
    setError(undefined);
  };

  return (
    <section class="px-8 py-4">
      <h1 class="text-2xl font-bold">Navmesh</h1>

      <Show
        when={navData()}
        fallback={
          <>
            <div
              class="text-xl rounded-xl p-10 text-center cursor-pointer"
              classList={{
                "bg-slate-700": !dropzone.isDragActive,
                "bg-green-900": dropzone.isDragActive,
              }}
              {...dropzone.getRootProps()}
            >
              <input {...dropzone.getInputProps()} accept=".nav" />
              <p>Drop a .nav file here, or click to open the file selection menu.</p>
            </div>
            <Show when={error()}>
              <div class="mt-4 text-red-500">{error()}</div>
            </Show>
          </>
        }
      >
        <button class="mb-2 px-3 py-1 bg-slate-600 hover:bg-slate-500 rounded" onClick={reset}>
          Load another
        </button>
        <NavMeshViewer navData={navData()!} fileName={fileName()} />
      </Show>
    </section>
  );
}
