function openTab(evt, tabName) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tabcontent");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tablink");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].style.backgroundColor = "";
    }
    document.getElementById(tabName).style.display = "block";
    evt.currentTarget.style.backgroundColor = "#ccc";
}

document.getElementById('zakrjna-form').addEventListener('submit', function(event) {
    event.preventDefault();

    let naradNumber = document.getElementById('narad-number').value;
    let model = document.getElementById('model').value;
    let quantity = document.getElementById('quantity').value;

    let newItem = document.createElement('li');
    newItem.innerHTML = `Наряд: ${naradNumber}, Модель: ${model}, Кількість: ${quantity} <button onclick="takeToWork(this)">Взяти в роботу</button>`;
    newItem.dataset.model = model;

    document.getElementById('zakrjna-list').appendChild(newItem);

    document.getElementById('zakrjna-form').reset();
});

function takeToWork(button) {
    let item = button.parentElement;
    button.remove();
    let newButton = document.createElement('button');
    newButton.innerHTML = 'Готово';
    newButton.onclick = function() { moveToShvejna(newButton); };
    item.appendChild(newButton);
}

function moveToShvejna(button) {
    let item = button.parentElement;
    item.removeChild(button);
    item.innerHTML += ' <button onclick="takeToWorkShvejna(this)">Взяти в роботу</button>';
    document.getElementById('shvejna-list').appendChild(item);
}

function takeToWorkShvejna(button) {
    let item = button.parentElement;
    button.remove();
    let newButton = document.createElement('button');
    newButton.innerHTML = 'Готово';
    newButton.onclick = function() { moveToZatjazhka(newButton); };
    item.appendChild(newButton);
}

function moveToZatjazhka(button) {
    let item = button.parentElement;
    item.removeChild(button);
    item.innerHTML += ' <button onclick="takeToWorkZatjazhka(this)">Взяти в роботу</button>';
    document.getElementById('zatjazhka-list').appendChild(item);
}

function takeToWorkZatjazhka(button) {
    let item = button.parentElement;
    button.remove();
    let newButton = document.createElement('button');
    newButton.innerHTML = 'Готово';
    newButton.onclick = function() { moveToGotovo(newButton); };
    item.appendChild(newButton);
}

function moveToGotovo(button) {
    let item = button.parentElement;
    item.removeChild(button);
    document.getElementById('gotovo-list').appendChild(item);
}

function filterByModel(listId, filterValue) {
    let list = document.getElementById(listId);
    let items = list.getElementsByTagName('li');
    filterValue = filterValue.toLowerCase();

    for (let i = 0; i < items.length; i++) {
        let model = items[i].dataset.model.toLowerCase();
        if (model.includes(filterValue)) {
            items[i].style.display = "";
        } else {
            items[i].style.display = "none";
        }
    }
}

// Відкриваємо першу вкладку за замовчуванням
document.getElementsByClassName('tablink')[0].click();