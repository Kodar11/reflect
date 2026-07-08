type FrameWindowAction = 'CLOSE' | 'MAXIMIZE' | 'MINIMIZE';

interface Window {
  app: {
    sendFrameAction: (payload: FrameWindowAction) => void;
  };
}
