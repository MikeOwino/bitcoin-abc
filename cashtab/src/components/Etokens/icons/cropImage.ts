// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import { Area } from 'react-easy-crop';

export interface ReaderResult {
    file: File;
    url: string;
}

export const createImage = (url: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image));
        image.addEventListener('error', error => reject(error));
        image.setAttribute('crossOrigin', 'anonymous');
        image.src = url;
    });

function getRadianAngle(degreeValue: number) {
    return (degreeValue * Math.PI) / 180;
}

export default async function getCroppedImg(
    imageSrc: string,
    pixelCrop: Area,
    rotation = 0,
    fileName: string,
): Promise<ReaderResult> {
    const image = await createImage(imageSrc);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const maxSize = Math.max(image.width, image.height);
    const safeArea = 2 * ((maxSize / 2) * Math.sqrt(2));

    canvas.width = safeArea;
    canvas.height = safeArea;

    if (ctx === null) {
        throw new Error('no ctx');
    }

    ctx.translate(safeArea / 2, safeArea / 2);
    ctx.rotate(getRadianAngle(rotation));
    ctx.translate(-safeArea / 2, -safeArea / 2);

    ctx.drawImage(
        image,
        safeArea / 2 - image.width * 0.5,
        safeArea / 2 - image.height * 0.5,
    );
    const data = ctx.getImageData(0, 0, safeArea, safeArea);

    canvas.width = pixelCrop.width;
    canvas.height = pixelCrop.height;

    ctx.putImageData(
        data,
        0 - safeArea / 2 + image.width * 0.5 - pixelCrop.x,
        0 - safeArea / 2 + image.height * 0.5 - pixelCrop.y,
    );

    if (!HTMLCanvasElement.prototype.toBlob) {
        Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
            value: function (
                callback: (blob: Blob) => void,
                type: string,
                quality: number,
            ) {
                const dataURL = this.toDataURL(type, quality).split(',')[1];
                setTimeout(function () {
                    const binStr = atob(dataURL),
                        len = binStr.length,
                        arr = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        arr[i] = binStr.charCodeAt(i);
                    }
                    callback(new Blob([arr], { type: type || 'image/png' }));
                });
            },
        });
    }
    return new Promise(resolve => {
        ctx.canvas.toBlob(
            blob => {
                if (blob === null) {
                    throw new Error('blob is null');
                }
                const file = new File([blob], fileName, {
                    type: 'image/png',
                });
                const resultReader = new FileReader();

                resultReader.readAsDataURL(file);

                resultReader.addEventListener('load', () =>
                    resolve({ file, url: resultReader.result as string }),
                );
            },
            'image/png',
            1,
        );
    });
}
