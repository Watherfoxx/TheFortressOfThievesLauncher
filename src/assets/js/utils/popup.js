/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer } = require('electron');

export default class popup {
    constructor() {
        this.popup = document.querySelector('.popup');
        this.popupTitle = document.querySelector('.popup-title');
        this.popupContent = document.querySelector('.popup-content');
        this.popupOptions = document.querySelector('.popup-options');
    }

    openPopup(info) {
        this.popup.style.display = 'flex';
        if (info.background == false) this.popup.style.background = 'none';
        else this.popup.style.background = '#000000b3'
        this.popupTitle.innerHTML = info.title;
        this.popupContent.style.color = info.color ? info.color : '#e21212';
        this.popupContent.innerHTML = info.content;

        this.popupOptions.innerHTML = '';
        this.popupOptions.style.display = 'none';

        if (info.options || info.buttons?.length) {
            this.popupOptions.style.display = 'flex';

            const buttons = info.buttons?.length ? info.buttons : [{
                text: 'OK',
                action: () => {
                    if (info.exit) return ipcRenderer.send('main-window-close');
                    this.closePopup();
                }
            }];

            buttons.forEach(buttonInfo => {
                const button = document.createElement('button');
                button.classList.add('popup-button');
                if (buttonInfo.className) button.classList.add(buttonInfo.className);
                button.innerHTML = buttonInfo.text;
                button.addEventListener('click', async () => {
                    if (buttonInfo.close !== false) this.closePopup();
                    if (typeof buttonInfo.action === 'function') await buttonInfo.action();
                });
                this.popupOptions.appendChild(button);
            });
        }
    }

    closePopup() {
        this.popup.style.display = 'none';
        this.popupTitle.innerHTML = '';
        this.popupContent.innerHTML = '';
        this.popupOptions.innerHTML = '';
        this.popupOptions.style.display = 'none';
    }
}
