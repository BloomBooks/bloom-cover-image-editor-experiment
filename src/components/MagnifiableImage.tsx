import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { AlertTriangle } from "lucide-react";

interface MagnifiableImageProps {
  src: string;
  alt: string;
  className?: string;
  magnification?: number; // zoom factor, default 2.5
  lensSize?: number; // diameter of the lens in pixels, default 150
  showDimensions?: boolean; // show "width x height" below the image
  expectedDimensions?: { width: number; height: number } | null; // dimensions to compare against for mismatch warning
  onLoad?: (dimensions: { width: number; height: number }) => void; // callback when image loads with its dimensions
  copyIcon?: React.ReactNode; // optional copy icon to show inline with dimensions
  downloadIcon?: React.ReactNode; // optional download icon to show inline with dimensions
}

/**
 * An image component that shows a magnifying glass lens on hover.
 * The lens follows the cursor and shows a zoomed view of that area.
 */
export default function MagnifiableImage({
  src,
  alt,
  className = "",
  magnification = 2.5,
  lensSize = 150,
  showDimensions = true,
  expectedDimensions = null,
  onLoad,
  copyIcon,
  downloadIcon,
}: MagnifiableImageProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [lensPos, setLensPos] = useState({ x: 0, y: 0 });
  const [bgPos, setBgPos] = useState({ x: 0, y: 0 });
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Use a ref to hold the latest onLoad callback to avoid re-running effects when it changes
  const onLoadRef = useRef(onLoad);
  useEffect(() => {
    onLoadRef.current = onLoad;
  }, [onLoad]);

  const handleImageLoad = useCallback(() => {
    if (imgRef.current) {
      const dims = {
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      };
      setDimensions(dims);
      onLoadRef.current?.(dims);
    }
  }, []);

  // Reset dimensions when src changes, but also check if image is already loaded (cached)
  useEffect(() => {
    setDimensions(null);
    // If image is already cached/complete, manually trigger the load handler
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      const dims = {
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      };
      setDimensions(dims);
      onLoadRef.current?.(dims);
    }
  }, [src]);

  // Check if dimensions mismatch expected
  const dimensionWarning = useMemo(() => {
    if (!dimensions || !expectedDimensions) return false;
    return dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height;
  }, [dimensions, expectedDimensions]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !imgRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const imgRect = imgRef.current.getBoundingClientRect();

      // Cursor position relative to image
      const cursorX = e.clientX - imgRect.left;
      const cursorY = e.clientY - imgRect.top;

      // Lens position (centered on cursor, but clamped to container)
      const halfLens = lensSize / 2;
      const lensX = Math.max(
        halfLens,
        Math.min(containerRect.width - halfLens, e.clientX - containerRect.left)
      );
      const lensY = Math.max(
        halfLens,
        Math.min(containerRect.height - halfLens, e.clientY - containerRect.top)
      );

      setLensPos({ x: lensX, y: lensY });

      // Background position for magnification
      // We need to show the zoomed area centered in the lens
      const bgX = cursorX * magnification - halfLens;
      const bgY = cursorY * magnification - halfLens;
      setBgPos({ x: bgX, y: bgY });
    },
    [lensSize, magnification]
  );

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
  }, []);

  return (
    <div className="flex flex-col">
      <div
        ref={containerRef}
        className={`relative ${className}`}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className="w-full h-full object-contain"
          draggable={false}
          onLoad={handleImageLoad}
        />

        {/* Magnifying lens */}
        {isHovering && imgRef.current && (
          <div
            className="pointer-events-none absolute rounded-full border-2 border-white shadow-lg overflow-hidden"
            style={{
              width: lensSize,
              height: lensSize,
              left: lensPos.x - lensSize / 2,
              top: lensPos.y - lensSize / 2,
              backgroundImage: `url(${src})`,
              backgroundSize: `${imgRef.current.offsetWidth * magnification}px ${imgRef.current.offsetHeight * magnification}px`,
              backgroundPosition: `-${bgPos.x}px -${bgPos.y}px`,
              backgroundRepeat: "no-repeat",
              zIndex: 50,
            }}
          />
        )}
      </div>
      {showDimensions && dimensions && (
        <div className={`text-xs mt-2 flex items-center ${dimensionWarning ? 'text-amber-400' : 'text-slate-500'}`}>
          <div className="flex items-center gap-1">
            {dimensionWarning && <AlertTriangle className="w-3 h-3" />}
            <span>{dimensions.width} × {dimensions.height}</span>
          </div>
          {(copyIcon || downloadIcon) && (
            <div className="flex items-center gap-2 ml-auto">
              {copyIcon}
              {downloadIcon}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
